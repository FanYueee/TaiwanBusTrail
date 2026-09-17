import type { BusShape, Direction } from "@/lib/types";
import { getCachedShape, putCachedShape } from "@/lib/storage/tdxCache";

import { fetchTdxJson } from "./apiClient";

/**
 * Shape loader（瀏覽器端）
 *
 * TDX 沒有回傳 Shape 時 shape = null，UI 會標示「無可用線型資料」，
 * 絕不以站牌直線代替。
 */

export interface LoadShapeResult {
  shape: BusShape | null;
  fetchedAt: string;
  fromCache: boolean;
}

export async function loadShape(
  routeUID: string,
  direction: Direction,
  options: { ttlDays: number; force?: boolean },
): Promise<LoadShapeResult> {
  if (!options.force) {
    const cached = await getCachedShape(routeUID, direction, options.ttlDays);
    if (cached) {
      return {
        shape: cached.geometry
          ? {
              routeUID: cached.routeUID,
              direction: cached.direction,
              geometry: cached.geometry,
              updatedAt: cached.updatedAt,
            }
          : null,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
      };
    }
  }

  const params = new URLSearchParams({
    routeUID,
    direction: String(direction),
  });
  if (options.force) params.set("force", "1");
  const response = await fetchTdxJson<{ shape: BusShape | null }>(
    `/api/tdx/shapes?${params.toString()}`,
  );
  const fetchedAt = new Date().toISOString();
  await putCachedShape(response.shape, routeUID, direction, fetchedAt);
  return { shape: response.shape, fetchedAt, fromCache: false };
}
