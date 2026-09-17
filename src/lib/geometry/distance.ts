import type { LatLon } from "@/lib/types";

/**
 * 幾何距離工具
 *
 * 以等距圓柱投影（equirectangular）計算區域尺度（台中市約 40km）的距離，
 * 對本專案（公車路網比對）精度足夠且運算快。
 */

const EARTH_RADIUS_M = 6371008.8;

export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function haversineMeters(a: LatLon, b: LatLon): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pathLengthMeters(points: LatLon[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineMeters(points[i - 1], points[i]);
  }
  return total;
}

export function interpolate(a: LatLon, b: LatLon, t: number): LatLon {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

// ---------- 區域平面投影（以 origin 為原點，單位：公尺） ----------

export interface LocalPoint {
  x: number;
  y: number;
}

export function toLocalMeters(point: LatLon, origin: LatLon): LocalPoint {
  return {
    x: toRadians(point.lon - origin.lon) * EARTH_RADIUS_M * Math.cos(toRadians(origin.lat)),
    y: toRadians(point.lat - origin.lat) * EARTH_RADIUS_M,
  };
}

export function fromLocalMeters(local: LocalPoint, origin: LatLon): LatLon {
  return {
    lat: origin.lat + toDegrees(local.y / EARTH_RADIUS_M),
    lon:
      origin.lon +
      toDegrees(local.x / (EARTH_RADIUS_M * Math.cos(toRadians(origin.lat)))),
  };
}

// ---------- 點與線段 ----------

export interface SegmentProjection {
  distanceMeters: number;
  /** 投影點在線段上的比例（0=起點, 1=終點） */
  t: number;
  closest: LatLon;
}

export function projectPointOnSegment(
  point: LatLon,
  a: LatLon,
  b: LatLon,
): SegmentProjection {
  const pa = toLocalMeters(point, a);
  const ba = toLocalMeters(b, a);
  const lengthSq = ba.x * ba.x + ba.y * ba.y;

  const t = lengthSq > 0 ? clamp01((pa.x * ba.x + pa.y * ba.y) / lengthSq) : 0;
  const cx = t * ba.x;
  const cy = t * ba.y;
  return {
    distanceMeters: Math.hypot(pa.x - cx, pa.y - cy),
    t,
    closest: fromLocalMeters({ x: cx, y: cy }, a),
  };
}

export interface SegmentProjectionDetail {
  distanceMeters: number;
  /** 投影點沿線距起點的距離（未 clamp，可能為負或超過線段長） */
  alongMeters: number;
  /** 線段長度（公尺） */
  lengthMeters: number;
}

/**
 * 投影到線段的「無限延長線」，並保留未 clamp 的沿線距離。
 * 用於判斷投影點是否落線上段內部（避免把線段端點外的點誤判為同一條路）。
 */
export function projectPointOnSegmentDetailed(
  point: LatLon,
  a: LatLon,
  b: LatLon,
): SegmentProjectionDetail {
  const pa = toLocalMeters(point, a);
  const ba = toLocalMeters(b, a);
  const length = Math.hypot(ba.x, ba.y);
  if (length === 0) {
    return {
      distanceMeters: haversineMeters(point, a),
      alongMeters: 0,
      lengthMeters: 0,
    };
  }

  const along = (pa.x * ba.x + pa.y * ba.y) / length;
  const t = clamp01(along / length);
  const distance = Math.hypot(pa.x - t * ba.x, pa.y - t * ba.y);
  return { distanceMeters: distance, alongMeters: along, lengthMeters: length };
}

/** 線段方向角（弧度，0 = 正北，順時針為正） */
export function segmentHeadingRadians(a: LatLon, b: LatLon): number {
  const origin = a;
  const local = toLocalMeters(b, origin);
  return Math.atan2(local.x, local.y);
}

/** 兩方向角的夾角（0～π/2；同向與反向皆視為 0，垂直為 π/2） */
export function headingDifferenceRadians(h1: number, h2: number): number {
  let diff = Math.abs(h1 - h2) % Math.PI;
  if (diff > Math.PI / 2) diff = Math.PI - diff;
  return diff;
}

export function pointToSegmentDistanceMeters(
  point: LatLon,
  a: LatLon,
  b: LatLon,
): number {
  return projectPointOnSegment(point, a, b).distanceMeters;
}

export interface PolylineProjection {
  /** 投影點落在第幾段（polyline[segmentIndex] → polyline[segmentIndex+1]） */
  segmentIndex: number;
  t: number;
  distanceMeters: number;
  /** 沿線累積距離（公尺），由 polyline[0] 起算 */
  alongMeters: number;
  point: LatLon;
}

export function projectPointOnPolyline(
  point: LatLon,
  polyline: LatLon[],
): PolylineProjection | null {
  if (polyline.length === 0) return null;
  if (polyline.length === 1) {
    return {
      segmentIndex: 0,
      t: 0,
      distanceMeters: haversineMeters(point, polyline[0]),
      alongMeters: 0,
      point: polyline[0],
    };
  }

  let best: PolylineProjection | null = null;
  let along = 0;

  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const segmentLength = haversineMeters(a, b);
    const projection = projectPointOnSegment(point, a, b);

    if (best === null || projection.distanceMeters < best.distanceMeters) {
      best = {
        segmentIndex: i,
        t: projection.t,
        distanceMeters: projection.distanceMeters,
        alongMeters: along + segmentLength * projection.t,
        point: projection.closest,
      };
    }

    along += segmentLength;
  }

  return best;
}

// ---------- 沿線距離操作 ----------

/** 回傳每個頂點的累積距離，cum[0] = 0 */
export function cumulativeLengths(points: LatLon[]): number[] {
  const cum = new Array<number>(points.length);
  cum[0] = 0;
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1] + haversineMeters(points[i - 1], points[i]);
  }
  return cum;
}

/** 取得沿線指定距離處的座標（distance 會被 clamp 到 [0, 總長]） */
export function pointAtDistance(
  points: LatLon[],
  cumulative: number[],
  distance: number,
): LatLon {
  if (points.length === 0) throw new Error("pointAtDistance: 空線段");
  if (points.length === 1) return points[0];

  const total = cumulative[cumulative.length - 1];
  const target = Math.max(0, Math.min(total, distance));

  let low = 0;
  let high = cumulative.length - 1;
  while (low < high - 1) {
    const mid = (low + high) >> 1;
    if (cumulative[mid] <= target) low = mid;
    else high = mid;
  }

  const segmentLength = cumulative[high] - cumulative[low];
  const t = segmentLength > 0 ? (target - cumulative[low]) / segmentLength : 0;
  return interpolate(points[low], points[high], t);
}

/**
 * 依起訖沿線距離切出子線段（含頭尾內插點），
 * 保留原始頂點作為轉折，不會產生站牌直線。
 */
export function slicePolylineByDistance(
  points: LatLon[],
  cumulative: number[],
  startAlong: number,
  endAlong: number,
): LatLon[] {
  if (points.length < 2) return points.slice();

  const start = Math.min(startAlong, endAlong);
  const end = Math.max(startAlong, endAlong);

  const result: LatLon[] = [pointAtDistance(points, cumulative, start)];
  for (let i = 0; i < points.length; i++) {
    if (cumulative[i] > start && cumulative[i] < end) {
      result.push(points[i]);
    }
  }
  result.push(pointAtDistance(points, cumulative, end));

  // 去除重複點（相鄰距離 < 1cm）
  const deduped: LatLon[] = [];
  for (const point of result) {
    const last = deduped[deduped.length - 1];
    if (!last || haversineMeters(last, point) > 0.01) deduped.push(point);
  }
  return deduped;
}
