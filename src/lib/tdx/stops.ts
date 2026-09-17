import type { BusStop, Direction } from "@/lib/types";
import { getCachedStops, putCachedStops } from "@/lib/storage/tdxCache";

import { fetchTdxJson } from "./apiClient";

/** StopOfRoute loader（瀏覽器端） */

export interface LoadStopsResult {
  stops: BusStop[];
  fetchedAt: string;
  fromCache: boolean;
}

export async function loadStops(
  routeUID: string,
  direction: Direction,
  options: { ttlDays: number; force?: boolean },
): Promise<LoadStopsResult> {
  if (!options.force) {
    const cached = await getCachedStops(routeUID, direction, options.ttlDays);
    if (cached) {
      return { stops: cached.stops, fetchedAt: cached.fetchedAt, fromCache: true };
    }
  }

  const params = new URLSearchParams({
    routeUID,
    direction: String(direction),
  });
  if (options.force) params.set("force", "1");
  const response = await fetchTdxJson<{ stops: BusStop[] }>(
    `/api/tdx/stops?${params.toString()}`,
  );
  const fetchedAt = new Date().toISOString();
  await putCachedStops(response.stops, routeUID, direction, fetchedAt);
  return { stops: response.stops, fetchedAt, fromCache: false };
}
