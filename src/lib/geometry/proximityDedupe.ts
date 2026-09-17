import type { LatLon } from "@/lib/types";

import {
  headingDifferenceRadians,
  projectPointOnSegmentDetailed,
  segmentHeadingRadians,
} from "./distance";
import type { CoverageChunk } from "./coverage";
import { SegmentGridIndex } from "./spatialIndex";

/**
 * 路線幾何的接近度去重（在建立路網之前執行）
 *
 * 只靠「節點合併」無法處理同一條路上的不同車道：
 * 兩條路線可能橫向相距 15～40m、取樣相位也不同，點對點永遠對不上。
 * 這裡改用「點到線」判斷：
 *   - 附近已有畫過的線段（半徑內）、方向相近（同向或雙向同一條路）、
 *     且投影落線上段內 → 這個點不需要再畫
 *   - 垂直交叉、大角度轉彎 → 照畫，不會被吃掉
 *   - 投影落在線段端點外（例如別人已經轉彎、這條路還在前進）→ 照畫，
 *     避免路口／轉彎過後出現一段空白
 *   - 短缺口（≤ maxBridgePoints）用原幾何補回；長缺口斷開，但新區段會從缺口末端
 *     （最後一個被跳過的點）開始，與既有線段相接，不會留下空隙、也不會拉出長直線
 *
 * 產出的幾何再交給 buildRoadNetwork 串成連續路網。
 */

export interface ProximityDedupeInput {
  key: string;
  chunks: CoverageChunk[];
}

export interface ProximityDedupeOptions {
  /** 去重半徑（公尺）：容納同一條路的車道偏移，預設 20 */
  radiusMeters?: number;
  /** 同向容許角度差（度），預設 35 */
  maxHeadingDiffDeg?: number;
  /** 短缺口橋接上限（點數），預設 3 */
  maxBridgePoints?: number;
  /** 投影點允許超過線段端點的長度（公尺），預設 5 */
  endExtensionMeters?: number;
  /** 距離小於此值時不看方向，直接視為已畫過（公尺），預設 6 */
  closeDistanceMeters?: number;
}

const MIN_SEGMENT_FOR_HEADING_METERS = 8;

function totalPointCount(input: ProximityDedupeInput): number {
  let count = 0;
  for (const chunk of input.chunks) count += chunk.points.length;
  return count;
}

interface Piece {
  chunkIndex: number;
  points: LatLon[];
  covered: boolean;
}

export function dedupeByProximity(
  inputs: ProximityDedupeInput[],
  options: ProximityDedupeOptions = {},
): Map<string, CoverageChunk[]> {
  const radius = Math.max(3, options.radiusMeters ?? 20);
  const maxHeadingDiff = ((options.maxHeadingDiffDeg ?? 35) * Math.PI) / 180;
  const maxBridgePoints = Math.max(0, options.maxBridgePoints ?? 3);
  const endExtension = Math.max(0, options.endExtensionMeters ?? 5);
  const closeDistance = Math.max(0, options.closeDistanceMeters ?? 6);

  const sorted = [...inputs].sort(
    (a, b) => totalPointCount(b) - totalPointCount(a) || a.key.localeCompare(b.key),
  );

  const drawnIndex = new SegmentGridIndex(50);
  const pieces = new Map<string, Piece[]>();

  const processPhase = (coveredPhase: boolean) => {
    for (const input of sorted) {
      for (let chunkIndex = 0; chunkIndex < input.chunks.length; chunkIndex++) {
        const chunk = input.chunks[chunkIndex];
        if (chunk.covered !== coveredPhase || chunk.points.length < 2) continue;

        let current: Piece | null = null;
        let pending: LatLon[] = [];
        let lastSkipped: LatLon | null = null;

        for (let pointIndex = 0; pointIndex < chunk.points.length; pointIndex++) {
          const point = chunk.points[pointIndex];
          const previousPoint = chunk.points[pointIndex - 1] ?? null;
          const nextPoint = chunk.points[pointIndex + 1] ?? null;
          const heading = previousPoint
            ? segmentHeadingRadians(previousPoint, point)
            : nextPoint
              ? segmentHeadingRadians(point, nextPoint)
              : null;

          const alreadyDrawn = drawnIndex.findNearby(point, radius, (segment) => {
            if (segment.owner === input.key) return false;

            const detail = projectPointOnSegmentDetailed(point, segment.a, segment.b);
            if (detail.distanceMeters > radius) return false;

            // 投影點必須落線上段內（允許兩端少量延伸）。
            // 沒有這道檢查時，別人「過彎後」的線段會把這條路在路口後的點吃掉，
            // 造成轉彎後出現一段空白。
            if (
              detail.alongMeters < -endExtension ||
              detail.alongMeters > detail.lengthMeters + endExtension
            ) {
              return false;
            }

            // 非常近：視為同一條線（不論方向）
            if (detail.distanceMeters <= closeDistance) return true;

            if (heading === null || segment.lengthMeters < MIN_SEGMENT_FOR_HEADING_METERS) {
              return true;
            }

            // 方向相同或相反（同一條道路的雙向車道）皆視為已畫過
            return headingDifferenceRadians(heading, segment.headingRadians) <= maxHeadingDiff;
          });

          if (alreadyDrawn) {
            if (pending.length <= maxBridgePoints) pending.push(point);
            lastSkipped = point;
            continue;
          }

          let bridgeFrom: LatLon | null = null;
          if (pending.length > 0) {
            if (pending.length <= maxBridgePoints && current) {
              // 短缺口：用原幾何補回
              for (const pendingPoint of pending) current.points.push(pendingPoint);
            } else {
              if (current) {
                // 長缺口：只把這條 piece 延伸一小段到缺口起點（與既有線段相接），
                // 不能用缺口末端的點硬接，否則會拉出數公里的直線
                current.points.push(pending[0]);
                current = null;
              }
              // 新 piece 從缺口末端開始，同樣只補一小段
              bridgeFrom = lastSkipped;
            }
            pending = [];
            lastSkipped = null;
          }

          if (!current) {
            current = { chunkIndex, points: [], covered: chunk.covered };
            if (bridgeFrom) current.points.push(bridgeFrom);
            const list = pieces.get(input.key);
            if (list) list.push(current);
            else pieces.set(input.key, [current]);
          }
          current.points.push(point);

          // 索引這條 piece 內每一段實際畫出的幾何（含銜接段）
          const count = current.points.length;
          if (count >= 2) {
            const from = current.points[count - 2];
            const to = current.points[count - 1];
            if (from.lat !== to.lat || from.lon !== to.lon) {
              drawnIndex.add({ a: from, b: to, owner: input.key });
            }
          }
        }
      }
    }
  };

  // 先處理已走過（綠色優先），再處理未走過
  processPhase(true);
  processPhase(false);

  const result = new Map<string, CoverageChunk[]>();
  for (const input of sorted) {
    const list = (pieces.get(input.key) ?? [])
      .filter((piece) => piece.points.length >= 2)
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map((piece) => ({ points: piece.points, covered: piece.covered }));
    result.set(input.key, list);
  }

  return result;
}
