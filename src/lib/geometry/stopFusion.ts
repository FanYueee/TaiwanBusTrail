import type { BusStop, LatLon } from "@/lib/types";

import {
  cumulativeLengths,
  haversineMeters,
  interpolate,
  projectPointOnPolyline,
  projectPointOnSegment,
  slicePolylineByDistance,
} from "./distance";
import { SegmentGridIndex } from "./spatialIndex";

/**
 * 以「連續站牌區間」為單位的路線融合
 *
 * 合併路網不再逐點去重（容易在路口留下缺口），而是：
 *   1. 每條路線依「連續站牌」把 Shape 切成一段段（含頭尾不入站的路段）
 *   2. 區間端點吸附到站牌座標 —— 站牌是各路線共用的精確錨點，
 *      因此同一站的線段端點會完全重合，路口不會有缺口
 *   3. 相同 fromStopUID→toStopUID 且線形相近的區間只取一條代表（保留路線名單）
 *   4. 不同站牌區間但整段都落在既有線段附近（誤差內）者不再重複畫
 *   5. 只有「整段都被涵蓋」才會被刪除，因此不會像逐點去重那樣把
 *      轉彎處的一小段吃掉、留下空白
 *
 * 輸出每一段的代表路線（popup 用）與完整幾何，再交給 buildRoadNetwork 串成路網。
 */

export interface StopFusionRoute {
  /** 路線 key（routeUID:direction） */
  routeKey: string;
  /** Shape 幾何 */
  shape: LatLon[];
  /** 依 sequence 排序的站牌 */
  stops: BusStop[];
}

export interface StopFusionOptions {
  /** 既有線段的容許距離（公尺），超過就會保留這一段；預設 12 */
  keepToleranceMeters?: number;
  /** 端點吸附站牌的最大距離（公尺），超過就不吸附；預設 25 */
  maxSnapMeters?: number;
  /** 頭尾不入站路段的最短保留長度（公尺），預設 30 */
  minLeadMeters?: number;
}

export interface FusedSlice {
  /** 代表路線 key */
  routeKey: string;
  /** 這條走廊上其他共用路線的 key（popup 用） */
  extraRouteKeys: string[];
  points: LatLon[];
}

interface SliceRecord {
  pairId: string;
  routeKey: string;
  points: LatLon[];
  extraRouteKeys: string[];
}

function cleanPoints(points: LatLon[]): LatLon[] {
  const cleaned: LatLon[] = [];
  for (const point of points) {
    const last = cleaned[cleaned.length - 1];
    if (!last || haversineMeters(last, point) > 0.01) cleaned.push(point);
  }
  return cleaned;
}

export function fuseRoutesByStops(
  routes: StopFusionRoute[],
  options: StopFusionOptions = {},
): FusedSlice[] {
  const keepTolerance = Math.max(1, options.keepToleranceMeters ?? 12);
  const maxSnap = Math.max(0, options.maxSnapMeters ?? 25);
  const minLead = Math.max(0, options.minLeadMeters ?? 30);

  // 點最多的 Shape 優先，通常數化最細緻
  const sorted = [...routes].sort(
    (a, b) => b.shape.length - a.shape.length || a.routeKey.localeCompare(b.routeKey),
  );

  const slices: SliceRecord[] = [];

  for (const route of sorted) {
    const { shape, stops } = route;
    if (shape.length < 2 || stops.length < 2) continue;

    const cumulative = cumulativeLengths(shape);
    const totalLength = cumulative[cumulative.length - 1];

    const projectionAt = (stop: BusStop) =>
      projectPointOnPolyline({ lat: stop.lat, lon: stop.lon }, shape);

    const pushSlice = (
      pairId: string,
      fromStop: BusStop | null,
      toStop: BusStop | null,
      fromAlong: number,
      toAlong: number,
    ) => {
      const raw = slicePolylineByDistance(shape, cumulative, fromAlong, toAlong);
      if (raw.length < 2) return;
      const points = raw.map((point) => ({ ...point }));

      const snap = (endpoint: LatLon, stop: BusStop | null) => {
        if (!stop) return;
        const distance = haversineMeters(endpoint, stop);
        if (distance > 0.5 && distance <= maxSnap) {
          endpoint.lat = stop.lat;
          endpoint.lon = stop.lon;
        }
      };
      snap(points[0], fromStop);
      snap(points[points.length - 1], toStop);

      const cleaned = cleanPoints(points);
      if (cleaned.length < 2) return;
      slices.push({ pairId, routeKey: route.routeKey, points: cleaned, extraRouteKeys: [] });
    };

    const firstProjection = projectionAt(stops[0]);
    const lastProjection = projectionAt(stops[stops.length - 1]);
    if (!firstProjection || !lastProjection) continue;

    if (firstProjection.alongMeters > minLead) {
      pushSlice(`lead-in`, null, stops[0], 0, firstProjection.alongMeters);
    }
    if (totalLength - lastProjection.alongMeters > minLead) {
      pushSlice(`lead-out`, stops[stops.length - 1], null, lastProjection.alongMeters, totalLength);
    }

    for (let i = 0; i < stops.length - 1; i++) {
      const from = stops[i];
      const to = stops[i + 1];
      const fromProjection = projectionAt(from);
      const toProjection = projectionAt(to);
      if (!fromProjection || !toProjection) continue;
      if (toProjection.alongMeters <= fromProjection.alongMeters) continue;
      pushSlice(
        `${from.stopUID}>${to.stopUID}`,
        from,
        to,
        fromProjection.alongMeters,
        toProjection.alongMeters,
      );
    }
  }

  // ---------- 融合 ----------
  const drawn = new SegmentGridIndex(50);
  const kept: SliceRecord[] = [];
  const keptByPair = new Map<string, SliceRecord>();

  const pointCovered = (point: LatLon): boolean => {
    let covered = false;
    drawn.findNearby(point, keepTolerance, (segment) => {
      if (projectPointOnSegment(point, segment.a, segment.b).distanceMeters <= keepTolerance) {
        covered = true;
        return true;
      }
      return false;
    });
    return covered;
  };

  const wholeSliceCovered = (slice: SliceRecord): boolean => {
    for (let i = 1; i < slice.points.length; i++) {
      const from = slice.points[i - 1];
      const to = slice.points[i];
      const length = haversineMeters(from, to);
      const steps = Math.max(1, Math.ceil(length / 15));
      for (let step = 0; step <= steps; step++) {
        if (!pointCovered(interpolate(from, to, step / steps))) return false;
      }
    }
    return true;
  };

  const similarTo = (candidate: SliceRecord, representative: SliceRecord): boolean => {
    const index = new SegmentGridIndex(50);
    for (let i = 1; i < representative.points.length; i++) {
      index.add({ a: representative.points[i - 1], b: representative.points[i] });
    }
    for (let i = 1; i < candidate.points.length; i++) {
      const from = candidate.points[i - 1];
      const to = candidate.points[i];
      const length = haversineMeters(from, to);
      const steps = Math.max(1, Math.ceil(length / 15));
      for (let step = 0; step <= steps; step++) {
        const point = interpolate(from, to, step / steps);
        let near = false;
        index.findNearby(point, keepTolerance, (segment) => {
          if (projectPointOnSegment(point, segment.a, segment.b).distanceMeters <= keepTolerance) {
            near = true;
            return true;
          }
          return false;
        });
        if (!near) return false;
      }
    }
    return true;
  };

  const ownerOfPoint = (point: LatLon): number => {
    let owner = -1;
    drawn.findNearby(point, keepTolerance, (segment) => {
      if (
        owner < 0 &&
        projectPointOnSegment(point, segment.a, segment.b).distanceMeters <= keepTolerance
      ) {
        owner = segment.owner === undefined ? -1 : Number(segment.owner);
        return true;
      }
      return false;
    });
    return owner;
  };

  for (const slice of slices) {
    // 同一組站牌區間：線形相近就只留一條，並把路線記到代表上
    if (slice.pairId !== "lead-in" && slice.pairId !== "lead-out") {
      const existing = keptByPair.get(slice.pairId);
      if (existing && similarTo(slice, existing)) {
        existing.extraRouteKeys.push(slice.routeKey);
        continue;
      }
    }

    const quick = [
      slice.points[0],
      slice.points[Math.floor(slice.points.length / 2)],
      slice.points[slice.points.length - 1],
    ];
    const quickFar = quick.some((point) => !pointCovered(point));
    if (!quickFar && wholeSliceCovered(slice)) {
      // 整段已被畫過：把路線記到最近的既有片段（popup 用）
      const owner = ownerOfPoint(slice.points[0]);
      const target = owner >= 0 ? kept[owner] : undefined;
      if (target && target.routeKey !== slice.routeKey) {
        target.extraRouteKeys.push(slice.routeKey);
      }
      continue;
    }

    const index = kept.length;
    for (let i = 1; i < slice.points.length; i++) {
      drawn.add({ a: slice.points[i - 1], b: slice.points[i], owner: String(index) });
    }
    kept.push(slice);
    if (
      slice.pairId !== "lead-in" &&
      slice.pairId !== "lead-out" &&
      !keptByPair.has(slice.pairId)
    ) {
      keptByPair.set(slice.pairId, slice);
    }
  }

  return kept.map((slice) => ({
    routeKey: slice.routeKey,
    extraRouteKeys: [...new Set(slice.extraRouteKeys)],
    points: slice.points,
  }));
}
