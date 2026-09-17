import type { LatLon } from "@/lib/types";

import { haversineMeters, interpolate, segmentHeadingRadians } from "./distance";
import type { CoverageMatcher } from "./matcher";

/**
 * 將一條 Shape 切成「已走過 / 未走過」的連續區段。
 *
 * 作法：
 *   1. 將 Shape 線上重新取樣，任一小段長度不超過 sampleSpacing
 *      （預設為容差的一半，避免長直線段跨越已走過與未走過的交界）
 *   2. 對每個小段取中點，連同小段方向交給 CoverageMatcher 判斷
 *   3. 補上單點縫隙（前後都已走過、只有一點未命中，通常是幾何誤差）
 *   4. 合併相鄰同性質的小段，輸出 chunks 供地圖繪製紅/綠線
 */

export interface CoverageChunk {
  points: LatLon[];
  covered: boolean;
}

export interface CoverageOptions {
  /** 重新取樣間距（公尺）。預設 tolerance / 2 */
  sampleSpacingMeters?: number;
}

/** 太短的區段方向雜訊大，不做方向檢查 */
const MIN_HEADING_SEGMENT_METERS = 3;

export function computeCoverage(
  points: LatLon[],
  matcher: CoverageMatcher,
  options: CoverageOptions = {},
): CoverageChunk[] {
  if (points.length < 2) {
    return [{ points: points.slice(), covered: false }];
  }

  const spacing = Math.max(
    2,
    options.sampleSpacingMeters ?? matcher.toleranceMeters / 2,
  );

  // 1. 重新取樣
  const sampled: LatLon[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const segmentStart = points[i - 1];
    const segmentEnd = points[i];
    const length = haversineMeters(segmentStart, segmentEnd);
    const steps = Math.max(1, Math.ceil(length / spacing));
    for (let step = 1; step <= steps; step++) {
      sampled.push(interpolate(segmentStart, segmentEnd, step / steps));
    }
  }

  // 2. 逐小段判斷（flags[i] 對應 sampled[i] → sampled[i+1]）
  const flags: boolean[] = [];
  for (let i = 0; i < sampled.length - 1; i++) {
    const start = sampled[i];
    const end = sampled[i + 1];
    const length = haversineMeters(start, end);
    const heading = length >= MIN_HEADING_SEGMENT_METERS ? segmentHeadingRadians(start, end) : null;
    const midpoint = interpolate(start, end, 0.5);
    flags.push(matcher.isPointCovered(midpoint, heading));
  }

  // 3. 補洞：單點未命中但前後都已走過
  for (let i = 1; i < flags.length - 1; i++) {
    if (!flags[i] && flags[i - 1] && flags[i + 1]) flags[i] = true;
  }

  // 4. 合併連續區段
  const chunks: CoverageChunk[] = [];
  let start = 0;
  for (let i = 1; i <= flags.length; i++) {
    if (i === flags.length || flags[i] !== flags[start]) {
      chunks.push({
        points: sampled.slice(start, i + 1),
        covered: flags[start],
      });
      start = i;
    }
  }

  return chunks;
}
