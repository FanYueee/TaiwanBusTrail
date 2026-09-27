import type { LatLon } from "../types";

/** Stable geometry version for saved full-route rides (not a security hash). */
export function shapeFingerprint(points: LatLon[]): string {
  let hash = 2166136261;
  for (const p of points) for (const value of [Math.round(p.lat * 1e6), Math.round(p.lon * 1e6)]) {
    hash = Math.imul(hash ^ value, 16777619) >>> 0;
  }
  return `${points.length}:${hash.toString(16)}`;
}
