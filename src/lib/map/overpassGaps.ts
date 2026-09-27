import type { NetworkChainData } from "@/components/types";
import type { LatLon } from "@/lib/types";

interface ScreenPoint { x: number; y: number }
interface ScreenSegment {
  chain: number;
  part: number;
  grade: number;
  a: ScreenPoint;
  b: ScreenPoint;
  length: number;
}

const CELL_SIZE = 64;
const key = (x: number, y: number) => `${x},${y}`;
const cross = (a: ScreenPoint, b: ScreenPoint) => a.x * b.y - a.y * b.x;
const subtract = (a: ScreenPoint, b: ScreenPoint): ScreenPoint => ({ x: a.x - b.x, y: a.y - b.y });
const between = (a: LatLon, b: LatLon, t: number): LatLon => ({
  lat: a.lat + (b.lat - a.lat) * t,
  lon: a.lon + (b.lon - a.lon) * t,
});

/** Break only the lower drawn stroke at a geometric crossing with another grade. */
export function splitAtGradeCrossings(
  chains: NetworkChainData[],
  project: (point: LatLon) => ScreenPoint,
  gapPixels = 5,
): LatLon[][][] {
  const segments: ScreenSegment[] = [];
  const cells = new Map<string, number[]>();
  chains.forEach((chain, chainIndex) => {
    const grade = Number(chain.level?.split("|")[0] ?? 0);
    const points = chain.points.map(project);
    for (let part = 0; part < points.length - 1; part++) {
      const a = points[part], b = points[part + 1];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 0.1) continue;
      const segment: ScreenSegment = { chain: chainIndex, part, grade: Number.isFinite(grade) ? grade : 0, a, b, length };
      const id = segments.push(segment) - 1;
      for (let x = Math.floor(Math.min(a.x, b.x) / CELL_SIZE); x <= Math.floor(Math.max(a.x, b.x) / CELL_SIZE); x++) {
        for (let y = Math.floor(Math.min(a.y, b.y) / CELL_SIZE); y <= Math.floor(Math.max(a.y, b.y) / CELL_SIZE); y++) {
          const cell = key(x, y), bucket = cells.get(cell) ?? [];
          bucket.push(id); cells.set(cell, bucket);
        }
      }
    }
  });

  const gaps = new Map<number, Map<number, [number, number][]>>();
  const checked = new Set<string>();
  segments.forEach((segment, id) => {
    for (let x = Math.floor(Math.min(segment.a.x, segment.b.x) / CELL_SIZE); x <= Math.floor(Math.max(segment.a.x, segment.b.x) / CELL_SIZE); x++) {
      for (let y = Math.floor(Math.min(segment.a.y, segment.b.y) / CELL_SIZE); y <= Math.floor(Math.max(segment.a.y, segment.b.y) / CELL_SIZE); y++) {
        for (const otherId of cells.get(key(x, y)) ?? []) {
          if (otherId <= id) continue;
          const pair = `${id},${otherId}`;
          if (checked.has(pair)) continue;
          checked.add(pair);
          const other = segments[otherId];
          if (segment.grade === other.grade) continue;
          const first = subtract(segment.b, segment.a), second = subtract(other.b, other.a);
          const denominator = cross(first, second);
          if (Math.abs(denominator) < segment.length * other.length * 0.25) continue;
          const offset = subtract(other.a, segment.a);
          const t = cross(offset, second) / denominator, u = cross(offset, first) / denominator;
          if (t < 0 || t > 1 || u < 0 || u > 1) continue;
          // At a shared endpoint, a ramp can genuinely connect to an elevated road.
          const atEnd = (position: number, length: number) => Math.min(position, 1 - position) * length < 1;
          if (atEnd(t, segment.length) && atEnd(u, other.length)) continue;
          const lower = segment.grade < other.grade ? segment : other;
          const position = lower === segment ? t : u;
          const half = gapPixels / lower.length;
          const byPart = gaps.get(lower.chain) ?? new Map<number, [number, number][]>();
          const intervals = byPart.get(lower.part) ?? [];
          intervals.push([Math.max(0, position - half), Math.min(1, position + half)]);
          byPart.set(lower.part, intervals); gaps.set(lower.chain, byPart);
        }
      }
    }
  });

  return chains.map((chain, chainIndex) => {
    const byPart = gaps.get(chainIndex);
    if (!byPart) return [chain.points];
    const pieces: LatLon[][] = [];
    let current: LatLon[] = [chain.points[0]];
    for (let part = 0; part < chain.points.length - 1; part++) {
      const a = chain.points[part], b = chain.points[part + 1];
      const intervals = (byPart.get(part) ?? []).sort((left, right) => left[0] - right[0]);
      let from = 0;
      for (const [start, end] of intervals) {
        if (end <= from) continue;
        if (start > from) {
          current.push(between(a, b, start));
        }
        if (current.length > 1) pieces.push(current);
        current = [];
        from = end;
      }
      if (from < 1) {
        if (!current.length) current.push(between(a, b, from));
        current.push(b);
      }
    }
    if (current.length > 1) pieces.push(current);
    return pieces;
  });
}
