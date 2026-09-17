import type { RideRecord } from "@/lib/types";

import { SegmentGridIndex, type Segment } from "./spatialIndex";

/** 將所有搭乘紀錄的幾何轉為線段集合 */
export function rideRecordsToSegments(records: RideRecord[]): Segment[] {
  const segments: Segment[] = [];
  for (const record of records) {
    const points = record.geometry;
    for (let i = 1; i < points.length; i++) {
      segments.push({ a: points[i - 1], b: points[i] });
    }
  }
  return segments;
}

/**
 * 建立「已走過道路」的空間索引。
 * 這是重疊路段判斷的資料來源：不同公車只要幾何重疊，就會命中相同的已走過線段。
 */
export function buildExploredIndex(
  records: RideRecord[],
  cellSizeMeters?: number,
): SegmentGridIndex {
  const index = new SegmentGridIndex(cellSizeMeters);
  index.addMany(rideRecordsToSegments(records));
  return index;
}
