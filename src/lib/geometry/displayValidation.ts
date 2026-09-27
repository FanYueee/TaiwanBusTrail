import type { RoadNetworkChain } from "./roadNetwork";
import type { ReferenceRoadGraph, RoadRange } from "./referenceRoads";
import { haversineMeters, interpolate, projectPointOnSegment } from "./distance";

/** Offline safety gate. Provenance is verified BEFORE publishing a new network.
 * The displacement bound is a guard against runaway geometry, not an accuracy
 * certificate: a legitimate generalized junction may move along a road by 55m.
 */
export function validateRoadDisplay(graph: ReferenceRoadGraph, chains: RoadNetworkChain[], memberships: Record<string, string[]>) {
  const edges = new Map(graph.edges.map((e) => [e.id, e]));
  let maxDisplacementMeters = 0;
  for (const chain of chains) {
    if (chain.points.length < 2 || !chain.sourceEdgeIds?.length || !chain.routeKeys.length) throw new Error("Display chain has no native provenance");
    const sources = chain.sourceEdgeIds.map((id) => {
      const edge = edges.get(id);
      if (!edge) throw new Error(`Unknown display source: ${id}`);
      return edge;
    });
    for (const key of chain.routeKeys) if (!sources.some((e) => memberships[e.id]?.includes(key))) throw new Error(`Invented membership: ${key}`);
    for (let i = 1; i < chain.points.length; i++) {
      const a = chain.points[i - 1], b = chain.points[i];
      if (![a.lat, a.lon, b.lat, b.lon].every(Number.isFinite)) throw new Error("Non-finite display coordinates");
      const steps = Math.max(1, Math.ceil(haversineMeters(a, b) / 10));
      for (let j = 0; j <= steps; j++) {
        const point = interpolate(a, b, j / steps);
        const distance = Math.min(...sources.map((e) => projectPointOnSegment(point, e.a, e.b).distanceMeters));
        maxDisplacementMeters = Math.max(maxDisplacementMeters, distance);
        if (distance > 55) throw new Error(`Display escaped native corridor: ${chain.road ?? "unnamed"}, ${distance.toFixed(1)}m, ${chain.sourceEdgeIds.join(",")}`);
      }
    }
  }
  return { chains: chains.length, maxDisplacementMeters, invalidMemberships: 0 };
}

/** Compare native shared-node traversals with their displayed geometries.
 * This checks connectivity, unlike the displacement/provenance gate. It does
 * not invent missing source routes or treat a nearby unrelated road as ridden.
 */
export function auditDisplayConnectivity(graph: ReferenceRoadGraph, chains: RoadNetworkChain[], ranges: Record<string, RoadRange[]>, collapsed = new Set<string>()) {
  const bySource = new Map<string, RoadNetworkChain[]>();
  const chainIds = new Map(chains.map((c, i) => [c, i]));
  for (const chain of chains) for (const id of chain.sourceEdgeIds ?? []) {
    const list = bySource.get(id) ?? []; list.push(chain); bySource.set(id, list);
  }
  const gaps: { node: number; sources: string[]; routeKeys: string[]; meters: number }[] = [];
  let checked = 0;
  let collapsedTraversals = 0;
  for (const [node, ids] of graph.adjacency) {
    const incident = ids.flatMap((id) => {
      const edge = graph.edges[id], end = edge.from === node ? 0 : 1;
      const keys = (ranges[edge.id] ?? []).filter((r) => end === 0 ? r.from < 1e-8 : r.to > 1 - 1e-8).map((r) => r.key);
      const display = bySource.get(edge.id);
      return keys.length && display?.length ? [{ edge, keys, display }] : [];
    });
    for (let i = 0; i < incident.length; i++) for (let j = i + 1; j < incident.length; j++) {
      const a = incident[i], b = incident[j], keys = a.keys.filter((key) => b.keys.includes(key));
      if (!keys.length) continue;
      const patterns = new Map<string, { keys: string[]; first: RoadNetworkChain[]; second: RoadNetworkChain[] }>();
      for (const key of keys) {
        const first = a.display.filter((c) => c.routeKeys.includes(key)), second = b.display.filter((c) => c.routeKeys.includes(key));
        // Only an explicitly recorded geometric contraction may lack a line.
        // Do not silently ignore a missing route membership on a real segment.
        if ((!first.length && collapsed.has(`${a.edge.id}\0${key}`)) || (!second.length && collapsed.has(`${b.edge.id}\0${key}`))) {
          collapsedTraversals++; continue;
        }
        const signature = `${first.map((c) => chainIds.get(c)).join(",")}|${second.map((c) => chainIds.get(c)).join(",")}`;
        const pattern = patterns.get(signature) ?? { keys: [], first, second };
        pattern.keys.push(key); patterns.set(signature, pattern);
      }
      for (const pattern of patterns.values()) {
        checked++;
        let distance = Infinity;
        outer: for (const first of pattern.first) for (const second of pattern.second) {
          if (first === second) { distance = 0; break outer; }
          for (const [from, to] of [[first, second], [second, first]]) for (const p of from.points) {
            for (let k = 1; k < to.points.length; k++) distance = Math.min(distance, projectPointOnSegment(p, to.points[k - 1], to.points[k]).distanceMeters);
            if (distance < .25) break outer;
          }
        }
        if (distance > .25) gaps.push({ node, sources: [a.edge.id, b.edge.id], routeKeys: pattern.keys, meters: distance });
      }
    }
  }
  return { checked, collapsedTraversals, gaps: gaps.sort((a, b) => b.meters - a.meters) };
}
