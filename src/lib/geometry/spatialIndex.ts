import type { LatLon } from "@/lib/types";

import { haversineMeters, segmentHeadingRadians } from "./distance";

/**
 * 線段空間索引（均勻網格）
 *
 * 目的：在「已走過幾何」可能包含數萬條線段時，
 * 仍能快速查詢某點附近是否有已走過的線段。
 *
 * 使用全球一致的墨卡托網格；查詢半徑依當地緯度換算，
 * 因此不同縣市的公尺半徑不會受固定參考緯度影響。
 */

export interface Segment {
  a: LatLon;
  b: LatLon;
  /** 選用：線段擁有者（例如路線 key），供去重時排除自己的線段 */
  owner?: string;
}

/** 索引內部的線段：附帶方向角與長度，供平行度判斷使用 */
export interface IndexedSegment extends Segment {
  headingRadians: number;
  lengthMeters: number;
}

const EARTH_RADIUS = 6378137;
const RADIANS = Math.PI / 180;

const DEFAULT_CELL_SIZE_M = 50;

export function metricCellCoordinates(point: LatLon, cellSize: number): { cx: number; cy: number } {
  const latitude = Math.max(-85, Math.min(85, point.lat)) * RADIANS;
  return {
    cx: Math.floor((EARTH_RADIUS * point.lon * RADIANS) / cellSize),
    cy: Math.floor((EARTH_RADIUS * Math.asinh(Math.tan(latitude))) / cellSize),
  };
}

export function metricCellRing(radiusMeters: number, cellSize: number, latitude: number): number {
  const outerLatitude = Math.min(85, Math.abs(latitude) + radiusMeters / 110574);
  return Math.max(0, Math.ceil(radiusMeters / (cellSize * Math.cos(outerLatitude * RADIANS))));
}

function cellKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export class SegmentGridIndex {
  private readonly cellSize: number;
  private readonly cells = new Map<string, IndexedSegment[]>();

  constructor(cellSizeMeters: number = DEFAULT_CELL_SIZE_M) {
    this.cellSize = Math.max(5, cellSizeMeters);
  }

  get cellSizeMeters(): number {
    return this.cellSize;
  }

  add(segment: Segment): void {
    const indexed: IndexedSegment = {
      a: segment.a,
      b: segment.b,
      owner: segment.owner,
      headingRadians: segmentHeadingRadians(segment.a, segment.b),
      lengthMeters: haversineMeters(segment.a, segment.b),
    };

    const c1 = metricCellCoordinates(indexed.a, this.cellSize);
    const c2 = metricCellCoordinates(indexed.b, this.cellSize);
    const minX = Math.min(c1.cx, c2.cx);
    const maxX = Math.max(c1.cx, c2.cx);
    const minY = Math.min(c1.cy, c2.cy);
    const maxY = Math.max(c1.cy, c2.cy);

    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const key = cellKey(cx, cy);
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(indexed);
        else this.cells.set(key, [indexed]);
      }
    }
  }

  addMany(segments: Iterable<Segment>): void {
    for (const segment of segments) this.add(segment);
  }

  /**
   * 走訪半徑內的所有線段，一旦 test 回傳 true 立即結束。
   * 不做去重（同一線段可能跨多個網格），可避免配置額外物件，
   * 適合高頻的覆蓋判斷。
   */
  findNearby(
    point: LatLon,
    radiusMeters: number,
    test: (segment: IndexedSegment) => boolean,
  ): boolean {
    const center = metricCellCoordinates(point, this.cellSize);
    const ring = metricCellRing(radiusMeters, this.cellSize, point.lat);

    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        const bucket = this.cells.get(cellKey(center.cx + dx, center.cy + dy));
        if (!bucket) continue;
        for (const segment of bucket) {
          if (test(segment)) return true;
        }
      }
    }

    return false;
  }

  /** 查詢附近線段（可能重複，需自行再精算距離） */
  queryNearby(point: LatLon, radiusMeters: number): Segment[] {
    const found: Segment[] = [];
    this.findNearby(point, radiusMeters, (segment) => {
      found.push(segment);
      return false;
    });
    return found;
  }
}
