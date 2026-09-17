import { getDb, type CachedRoutesRow, type CachedShapeRow, type CachedStopsRow } from "./db";

import type { BusRoute, BusShape, BusStop, Direction } from "@/lib/types";

/** TDX 圖資快取：可由「更新公車資料」清除重建，不屬於個人資料 */

export const TAICHUNG_CITY = "Taichung";

export function shapeCacheKey(routeUID: string, direction: Direction): string {
  return `${routeUID}:${direction}`;
}

export function isFresh(fetchedAt: string, ttlDays: number): boolean {
  const fetched = Date.parse(fetchedAt);
  if (!Number.isFinite(fetched)) return false;
  if (ttlDays <= 0) return false;
  return Date.now() - fetched < ttlDays * 24 * 60 * 60 * 1000;
}

// ---------- Route ----------

export async function getCachedRoutes(
  ttlDays: number,
  city: string = TAICHUNG_CITY,
): Promise<CachedRoutesRow | null> {
  const row = await getDb().routes.get(city);
  if (!row) return null;
  return isFresh(row.fetchedAt, ttlDays) ? row : null;
}

export async function getCachedRoutesRow(
  city: string = TAICHUNG_CITY,
): Promise<CachedRoutesRow | null> {
  return (await getDb().routes.get(city)) ?? null;
}

export async function putCachedRoutes(
  routes: BusRoute[],
  fetchedAt: string,
  city: string = TAICHUNG_CITY,
): Promise<void> {
  await getDb().routes.put({ city, routes, fetchedAt });
}

// ---------- Shape ----------

export async function getCachedShape(
  routeUID: string,
  direction: Direction,
  ttlDays: number,
): Promise<CachedShapeRow | null> {
  const row = await getDb().shapes.get(shapeCacheKey(routeUID, direction));
  if (!row) return null;
  return isFresh(row.fetchedAt, ttlDays) ? row : null;
}

export async function putCachedShape(
  shape: BusShape | null,
  routeUID: string,
  direction: Direction,
  fetchedAt: string,
): Promise<void> {
  await getDb().shapes.put({
    key: shapeCacheKey(routeUID, direction),
    routeUID,
    direction,
    geometry: shape ? shape.geometry : null,
    updatedAt: shape?.updatedAt ?? null,
    fetchedAt,
  });
}

// ---------- Stops ----------

export async function getCachedStops(
  routeUID: string,
  direction: Direction,
  ttlDays: number,
): Promise<CachedStopsRow | null> {
  const row = await getDb().stops.get(shapeCacheKey(routeUID, direction));
  if (!row) return null;
  return isFresh(row.fetchedAt, ttlDays) ? row : null;
}

export async function putCachedStops(
  stops: BusStop[],
  routeUID: string,
  direction: Direction,
  fetchedAt: string,
): Promise<void> {
  await getDb().stops.put({
    key: shapeCacheKey(routeUID, direction),
    routeUID,
    direction,
    stops,
    fetchedAt,
  });
}

// ---------- 清除 ----------

export async function clearTdxCache(): Promise<void> {
  const db = getDb();
  await db.transaction("rw", db.routes, db.shapes, db.stops, async () => {
    await db.routes.clear();
    await db.shapes.clear();
    await db.stops.clear();
  });
}
