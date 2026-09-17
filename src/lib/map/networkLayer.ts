import type { NetworkChainData } from "@/components/types";
import type { LatLon } from "@/lib/types";

/**
 * 路網圖層的點擊查詢
 *
 * 合併路網用兩個 multi-polyline 圖層（紅/綠）繪製以維持效能，
 * 點擊時再以網格索引找出附近的路網鏈，組出「行經路線」popup。
 */

const REF_LAT = 24.15;
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos((REF_LAT * Math.PI) / 180);
const CELL_METERS = 120;
const LOOKUP_RADIUS_METERS = 60;

function cellKey(lat: number, lon: number): string {
  const cx = Math.floor((lon * M_PER_DEG_LON) / CELL_METERS);
  const cy = Math.floor((lat * M_PER_DEG_LAT) / CELL_METERS);
  return `${cx},${cy}`;
}

function localMeters(point: LatLon, origin: LatLon): { x: number; y: number } {
  return {
    x: (point.lon - origin.lon) * M_PER_DEG_LON,
    y: (point.lat - origin.lat) * M_PER_DEG_LAT,
  };
}

export function buildNetworkIndex(
  network: NetworkChainData[],
): Map<string, number[]> {
  const index = new Map<string, number[]>();

  network.forEach((chain, chainIndex) => {
    const seen = new Set<string>();
    for (const point of chain.points) {
      const key = cellKey(point.lat, point.lon);
      if (seen.has(key)) continue;
      seen.add(key);
      const bucket = index.get(key);
      if (bucket) bucket.push(chainIndex);
      else index.set(key, [chainIndex]);
    }
  });

  return index;
}

export interface NetworkLookupResult {
  covered: boolean;
  names: string[];
}

export function lookupNetworkAt(
  point: LatLon,
  network: NetworkChainData[],
  index: Map<string, number[]>,
): NetworkLookupResult {
  const [cxText, cyText] = cellKey(point.lat, point.lon).split(",");
  const cx = Number(cxText);
  const cy = Number(cyText);

  const candidates = new Set<number>();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const chainIndex of index.get(`${cx + dx},${cy + dy}`) ?? []) {
        candidates.add(chainIndex);
      }
    }
  }

  const names: string[] = [];
  let covered = false;
  let matched = false;

  for (const chainIndex of candidates) {
    const chain = network[chainIndex];
    let near = false;
    for (const chainPoint of chain.points) {
      const local = localMeters(chainPoint, point);
      if (Math.hypot(local.x, local.y) <= LOOKUP_RADIUS_METERS) {
        near = true;
        break;
      }
    }
    if (!near) continue;

    matched = true;
    covered = covered || chain.covered;
    for (const name of chain.routeNames) {
      if (names.length >= 15) break;
      if (!names.includes(name)) names.push(name);
    }
  }

  if (!matched) return { covered: false, names: [] };
  names.sort((a, b) => a.localeCompare(b, "zh-Hant", { numeric: true }));
  return { covered, names };
}
