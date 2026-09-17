import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import type { BusRoute, BusShape, BusStop, Direction, LatLon } from "@/lib/types";

/**
 * 公車資料來源（半離線）
 *
 * App 執行期「完全不呼叫 TDX」：Route / Shape / StopOfRoute 一律讀取
 * `npm run prefetch:tdx` 產生的本地檔案（data/tdx/*.json）。
 * TDX API 只在執行該預先下載腳本（或 Phase 1 驗證腳本）時使用。
 *
 * 好處：
 *   - 瀏覽器不需要網路也能拿公車資料（只有 OSM 底圖需要連線）
 *   - 不會受 TDX 速率限制（5 requests/分鐘）影響
 *   - 不會在背景偷偷把請求送到 TDX
 */

const PREFETCH_DIR = path.join(process.cwd(), "data", "tdx");

export class PrefetchMissingError extends Error {
  constructor(
    message = "尚未建立公車資料，請在專案目錄執行 npm run prefetch:tdx 後重新整理",
  ) {
    super(message);
    this.name = "PrefetchMissingError";
  }
}

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

export interface PrefetchedBundle {
  routes: BusRoute[];
  shapes: Record<string, PrefetchedShapeEntry>;
  stops: Record<string, BusStop[]>;
  meta: PrefetchMeta | null;
}

let prefetchedCache: PrefetchedBundle | null | undefined;

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** 讀取本地下載檔；不存在時回傳 null。force = true 會重新讀取磁碟（腳本更新後立即生效） */
export async function loadPrefetched(
  options: { force?: boolean } = {},
): Promise<PrefetchedBundle | null> {
  if (options.force) prefetchedCache = undefined;
  if (prefetchedCache !== undefined) return prefetchedCache;

  const [routes, shapes, stops, meta] = await Promise.all([
    readJsonFile<BusRoute[]>(path.join(PREFETCH_DIR, "routes.json")),
    readJsonFile<Record<string, PrefetchedShapeEntry>>(
      path.join(PREFETCH_DIR, "shapes.json"),
    ),
    readJsonFile<Record<string, BusStop[]>>(path.join(PREFETCH_DIR, "stops.json")),
    readJsonFile<PrefetchMeta>(path.join(PREFETCH_DIR, "meta.json")),
  ]);

  prefetchedCache =
    routes && shapes && stops ? { routes, shapes, stops, meta } : null;
  return prefetchedCache;
}

export interface PrefetchInfo {
  available: boolean;
  prefetchedAt: string | null;
  routeCount: number;
  shapeCount: number;
  missingShapeCount: number;
  stopCount: number;
}

export async function getPrefetchInfo(): Promise<PrefetchInfo> {
  const bundle = await loadPrefetched();
  if (!bundle) {
    return {
      available: false,
      prefetchedAt: null,
      routeCount: 0,
      shapeCount: 0,
      missingShapeCount: 0,
      stopCount: 0,
    };
  }

  const routeKeys = new Set(
    bundle.routes.map((route) => `${route.routeUID}:${route.direction}`),
  );
  const entries = Object.entries(bundle.shapes).filter(([key]) => routeKeys.has(key));

  return {
    available: true,
    prefetchedAt: bundle.meta?.prefetchedAt ?? null,
    routeCount: bundle.routes.length,
    shapeCount: entries.filter(([, entry]) => entry?.geometry).length,
    missingShapeCount: entries.filter(([, entry]) => !entry?.geometry).length,
    stopCount: Object.keys(bundle.stops).length,
  };
}

export function getCacheTtlDays(): number {
  const parsed = Number(process.env.TDX_CACHE_TTL_DAYS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 7;
}

// ---------- 對外 API（一律來自預先下載檔） ----------

async function requireBundle(options: { force?: boolean } = {}): Promise<PrefetchedBundle> {
  const bundle = await loadPrefetched(options);
  if (!bundle) throw new PrefetchMissingError();
  return bundle;
}

export async function fetchTaichungRoutes(
  options: { force?: boolean } = {},
): Promise<BusRoute[]> {
  return (await requireBundle(options)).routes;
}

export async function fetchTaichungShape(
  routeUID: string,
  direction: Direction,
  options: { force?: boolean } = {},
): Promise<BusShape | null> {
  const bundle = await requireBundle(options);
  const entry = bundle.shapes[`${routeUID}:${direction}`];
  if (entry === undefined) return null;
  if (!entry.geometry) return null; // TDX 無線型資料，不以站牌直線代替
  return {
    routeUID,
    direction,
    geometry: entry.geometry,
    updatedAt: entry.updatedAt,
  };
}

export async function fetchTaichungStops(
  routeUID: string,
  direction: Direction,
  options: { force?: boolean } = {},
): Promise<BusStop[]> {
  const bundle = await requireBundle(options);
  return bundle.stops[`${routeUID}:${direction}`] ?? [];
}

export async function fetchAllPrefetched(): Promise<PrefetchedBundle> {
  return requireBundle();
}
