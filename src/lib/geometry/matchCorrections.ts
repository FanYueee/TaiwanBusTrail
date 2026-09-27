import type { LatLon } from "../types";
import { interpolate, projectPointOnSegment } from "./distance";
import { ReferenceRoadGraph, type RoadRange } from "./referenceRoads";
import { SegmentGridIndex } from "./spatialIndex";

export interface ReviewedRoadCorrection {
  name: string;
  anchor: string;
  routes: string[];
  parts: { way: number; from: number; to: number }[];
}

/** Apply a reviewed native-road path only while its OSM topology and source
 * shape still support the recorded correction. Other cities need no file.
 */
export function applyReviewedRoadCorrections(
  graph: ReferenceRoadGraph,
  corrections: ReviewedRoadCorrection[],
  shapes: Record<string, { geometry: LatLon[] | null }>,
  memberships: Record<string, string[]>,
  ranges: Record<string, RoadRange[]>,
  matchedRoutes: Set<string>,
): void {
  const byId = new Map(graph.edges.map((edge) => [edge.id, edge]));
  for (const correction of corrections) {
    const path = correction.parts.flatMap(({ way, from, to }) =>
      Array.from({ length: to - from }, (_, i) => `${way}:${from + i}`));
    if (!path.length || path.at(-1) !== correction.anchor || new Set(path).size !== path.length) {
      throw new Error(`Invalid reviewed path: ${correction.name}`);
    }
    const edges = path.map((id) => {
      const edge = byId.get(id);
      if (!edge) throw new Error(`Reviewed road changed: ${correction.name} ${id}`);
      return edge;
    });
    for (let i = 1; i < edges.length; i++) if (edges[i - 1].to !== edges[i].from) {
      throw new Error(`Reviewed road is disconnected: ${correction.name} ${path[i]}`);
    }
    for (const key of correction.routes) {
      if (!matchedRoutes.has(key)) continue;
      if (!(memberships[correction.anchor] ?? []).includes(key)) {
        throw new Error(`Reviewed road no longer matches its anchor: ${correction.name} ${key}`);
      }
      const points = shapes[key]?.geometry;
      if (!points?.length) throw new Error(`Reviewed route shape is missing: ${correction.name} ${key}`);
      const index = new SegmentGridIndex(100);
      points.slice(1).forEach((point, i) => index.add({ a: points[i], b: point }));
      for (const edge of edges) {
        const middle = interpolate(edge.a, edge.b, .5);
        let offset = Infinity;
        index.findNearby(middle, 200, (segment) => {
          offset = Math.min(offset, projectPointOnSegment(middle, segment.a, segment.b).distanceMeters);
          return false;
        });
        if (offset > 200) throw new Error(`Reviewed road lost source support: ${correction.name} ${key} ${edge.id}`);
        const keys = memberships[edge.id] ??= [];
        if (!keys.includes(key)) keys.push(key);
        const entries = ranges[edge.id] ?? [];
        ranges[edge.id] = [...entries.filter((range) => range.key !== key), { from: 0, to: 1, key }];
      }
    }
  }
}
