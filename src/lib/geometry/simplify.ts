import type { LatLon } from "../types";
import { projectPointOnSegment } from "./distance";

/** 保留端點與轉彎；只移除偏離代表線段不超過容差的頂點。 */
export function simplifyPolyline(points: LatLon[], toleranceMeters = 2): LatLon[] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const pending: [number, number][] = [[0, points.length - 1]];
  while (pending.length) {
    const [start, end] = pending.pop()!;
    let farthest = toleranceMeters;
    let split = -1;
    for (let i = start + 1; i < end; i++) {
      const distance = projectPointOnSegment(points[i], points[start], points[end]).distanceMeters;
      if (distance > farthest) { farthest = distance; split = i; }
    }
    if (split >= 0) {
      keep[split] = 1;
      pending.push([start, split], [split, end]);
    }
  }
  return points.filter((_, index) => keep[index]);
}
