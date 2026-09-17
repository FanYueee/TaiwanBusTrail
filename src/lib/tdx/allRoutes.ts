import type { BusRoute, BusStop, LatLon } from "@/lib/types";
import { fetchTdxJson } from "./apiClient";

/** 「顯示全部路線」用的整包預先下載資料 */

export interface PrefetchedShapeEntry {
  geometry: LatLon[] | null;
  updatedAt: string | null;
}

export interface PrefetchMeta {
  city?: string;
  prefetchedAt?: string;
  routeCount?: number;
  shapeCount?: number;
  missingShapeKeys?: string[];
  stopKeyCount?: number;
  warnings?: string[];
}

export interface AllTdxData {
  routes: BusRoute[];
  shapes: Record<string, PrefetchedShapeEntry>;
  stops: Record<string, BusStop[]>;
  meta: PrefetchMeta | null;
}

export async function loadAllTdxData(): Promise<AllTdxData> {
  return fetchTdxJson<AllTdxData>("/api/tdx/all");
}
