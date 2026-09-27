import type { NetworkChainData } from "@/components/types";
import type { LatLon } from "@/lib/types";
import { projectPointOnSegment } from "../geometry/distance";
import { metricCellCoordinates, metricCellRing } from "../geometry/spatialIndex";

/**
 * 路網圖層的點擊查詢
 *
 * 合併路網用兩個 multi-polyline 圖層（藍/綠）繪製以維持效能，
 * 點擊時再以網格索引找出附近的路網鏈，組出「行經路線」popup。
 */

const CELL_METERS = 120;
const LOOKUP_RADIUS_METERS = 60;

function cellKey(lat: number, lon: number): string {
  const { cx, cy } = metricCellCoordinates({ lat, lon }, CELL_METERS);
  return `${cx},${cy}`;
}

export function buildNetworkIndex(
  network: NetworkChainData[],
): Map<string, number[]> {
  const index = new Map<string, number[]>();

  network.forEach((chain, chainIndex) => {
    const seen = new Set<string>();
    for (let i = 1; i < chain.points.length; i++) {
      const from = chain.points[i - 1];
      const to = chain.points[i];
      const [ax, ay] = cellKey(from.lat, from.lon).split(",").map(Number);
      const [bx, by] = cellKey(to.lat, to.lon).split(",").map(Number);
      for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) {
        for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) {
          const key = `${x},${y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const bucket = index.get(key);
          if (bucket) bucket.push(chainIndex);
          else index.set(key, [chainIndex]);
        }
      }
    }
  });

  return index;
}

export interface NetworkLookupResult {
  covered: boolean;
  mixed?: boolean;
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
  const ring = metricCellRing(LOOKUP_RADIUS_METERS, CELL_METERS, point.lat);
  for (let dx = -ring; dx <= ring; dx++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (const chainIndex of index.get(`${cx + dx},${cy + dy}`) ?? []) {
        candidates.add(chainIndex);
      }
    }
  }

  const names: string[] = [];
  const hits: { chain: NetworkChainData; distance: number }[] = [];
  for (const chainIndex of candidates) {
    const chain = network[chainIndex];
    let distance = Infinity;
    for (let i = 1; i < chain.points.length; i++) {
      distance = Math.min(distance, projectPointOnSegment(point, chain.points[i - 1], chain.points[i]).distanceMeters);
    }
    if (distance <= LOOKUP_RADIUS_METERS) hits.push({ chain, distance });
  }
  if (!hits.length) return { covered: false, names: [] };
  const closest = Math.min(...hits.map((hit) => hit.distance));
  const selected = hits.filter((hit) => hit.distance <= closest + .75);
  for (const { chain } of selected) {
    for (const name of chain.routeNames) {
      if (names.length >= 15) break;
      if (!names.includes(name)) names.push(name);
    }
  }

  names.sort((a, b) => a.localeCompare(b, "zh-Hant", { numeric: true }));
  const covered = selected.every(({ chain }) => chain.covered);
  const mixed = !covered && selected.some(({ chain }) => chain.covered);
  return mixed ? { covered, mixed, names } : { covered, names };
}
