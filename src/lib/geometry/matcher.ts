import type { LatLon } from "@/lib/types";

import {
  headingDifferenceRadians,
  projectPointOnSegmentDetailed,
} from "./distance";
import type { SegmentGridIndex } from "./spatialIndex";

/**
 * 覆蓋判斷策略（可抽換）
 *
 * v2「方向感知容差比對」：
 *   - 點與已走過線段的距離 <= tolerance
 *   - 投影點需落線上段內部（兩端各允許些許延伸），
 *     避免把線段端點外的位置誤判為已走過
 *   - 方向夾角需在允許範圍內（同向或反向皆可），
 *     讓容差放大時仍不會把交叉道路誤判為同一條
 *
 * 因為兩種 Shape 都來自 TDX，但可能走在不同車道（例如公車專用道 vs 慢車道），
 * 方向感知可讓 tolerance 開到 25～40m 仍保有一定準確度。
 * 未來若要處理 GPS 軌跡，可實作同樣介面的 map-matching 版本取代。
 */
export interface CoverageMatcher {
  readonly toleranceMeters: number;
  /** headingRadians 為 null 時不做方向檢查 */
  isPointCovered(point: LatLon, headingRadians: number | null): boolean;
}

export interface ToleranceMatcherOptions {
  toleranceMeters: number;
  /** 最大方向夾角（度），超過視為不同道路；預設 50 */
  maxHeadingDiffDeg?: number;
  /** 線段兩端允許延伸長度（公尺）；預設 10 */
  endExtensionMeters?: number;
  /** 距離小於此值時不做方向檢查（公尺）；預設 8 */
  headingSkipDistanceMeters?: number;
  /** 短於此長度的已走過線段不做方向檢查（公尺）；預設 8 */
  headingSkipSegmentMeters?: number;
}

export function createToleranceMatcher(
  index: SegmentGridIndex,
  options: ToleranceMatcherOptions,
): CoverageMatcher {
  const tolerance = Math.max(1, options.toleranceMeters);
  const maxHeadingDiff = ((options.maxHeadingDiffDeg ?? 50) * Math.PI) / 180;
  const endExtension = options.endExtensionMeters ?? 10;
  const headingSkipDistance = options.headingSkipDistanceMeters ?? 8;
  const headingSkipSegment = options.headingSkipSegmentMeters ?? 8;

  return {
    toleranceMeters: tolerance,
    isPointCovered(point: LatLon, headingRadians: number | null): boolean {
      return index.findNearby(point, tolerance, (segment) => {
        const detail = projectPointOnSegmentDetailed(point, segment.a, segment.b);
        if (detail.distanceMeters > tolerance) return false;

        // 投影點必須落線上段內部（允許兩端少量延伸）
        if (
          detail.alongMeters < -endExtension ||
          detail.alongMeters > detail.lengthMeters + endExtension
        ) {
          return false;
        }

        // 平行度檢查（距離很近或線段很短時跳過，避免誤殺轉彎處）
        if (
          headingRadians !== null &&
          detail.distanceMeters > headingSkipDistance &&
          detail.lengthMeters >= headingSkipSegment &&
          headingDifferenceRadians(headingRadians, segment.headingRadians) >
            maxHeadingDiff
        ) {
          return false;
        }

        return true;
      });
    },
  };
}
