import type { BusRoute } from "@/lib/types";
import { getCachedRoutes, putCachedRoutes } from "@/lib/storage/tdxCache";

import { fetchTdxJson } from "./apiClient";

/**
 * Route loader（瀏覽器端）
 * 先讀 IndexedDB 快取，過期或強制更新時才呼叫 /api/tdx/routes。
 */

export interface LoadRoutesResult {
  routes: BusRoute[];
  fetchedAt: string;
  fromCache: boolean;
}

export async function loadRoutes(options: {
  ttlDays: number;
  force?: boolean;
}): Promise<LoadRoutesResult> {
  if (!options.force) {
    const cached = await getCachedRoutes(options.ttlDays);
    // 舊版快取沒有業者欄位，視為過期重抓
    if (cached && cached.routes.every((route) => Array.isArray(route.operatorIDs))) {
      return { routes: cached.routes, fetchedAt: cached.fetchedAt, fromCache: true };
    }
  }

  const url = options.force ? "/api/tdx/routes?force=1" : "/api/tdx/routes";
  const response = await fetchTdxJson<{ routes: BusRoute[] }>(url);
  const fetchedAt = new Date().toISOString();
  await putCachedRoutes(response.routes, fetchedAt);
  return { routes: response.routes, fetchedAt, fromCache: false };
}
