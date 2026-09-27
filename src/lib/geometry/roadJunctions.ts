import type { LatLon } from "../types";
import type { ReferenceRoadGraph, ReferenceEdge, ReferenceWay } from "./referenceRoads";
import { haversineMeters } from "./distance";
import { SegmentGridIndex } from "./spatialIndex";

export const roadLevel = (edge: ReferenceEdge) => {
  const tags = edge.way.tags;
  const bridge = !!tags.bridge && tags.bridge !== "no", tunnel = !!tags.tunnel && tags.tunnel !== "no";
  return [tags.layer ?? (bridge ? "1" : tunnel ? "-1" : "0"), bridge ? "yes" : "no", tunnel ? "yes" : "no"].join("|");
};
export const roadFamily = (name: string) => name.replaceAll("臺", "台").replace(/[一二三四五六七八九十百\d]+段$/, "");
export interface Junction {
  center: LatLon; radius: number; level: string; names: string[]; nodes: number[];
  coreNodes: number[];
  turns: { nodes: number[]; edgeIds: string[] }[];
}
interface Seed { node: number; point: LatLon; names: string[]; signature: string; span: number }
const minorClass = (highway: string) => /^(residential|unclassified|service|busway)$/.test(highway);
const eligible = (edge: ReferenceEdge) => roadLevel(edge) === "0|no|no" && !!edge.way.tags.name
  && (/^(primary|secondary|tertiary)(?:_link)?$/.test(edge.way.tags.highway)
    || (minorClass(edge.way.tags.highway) && /^(yes|1|-1)$/.test(edge.way.tags.oneway ?? "")))
  && edge.way.tags.junction !== "roundabout";

/** Contract a bounded, connected native junction, NOT every line in a circle.
 * Equal street families distinguish adjacent intersections on the same artery.
 * All decisions use immutable native coordinates: contractions cannot cascade.
 */
export function detectRoadJunctions(graph: ReferenceRoadGraph, memberships: Record<string, string[]>): Junction[] {
  const seeds: Seed[] = [];
  const protectedNodes = new Set<number>();
  for (const [node, ids] of graph.adjacency) {
    const edges = ids.map((id) => graph.edges[id]);
    if (edges.some((e) => roadLevel(e) !== "0|no|no" || e.way.tags.junction === "roundabout" || /^(motorway|motorway_link|trunk|trunk_link)$/.test(e.way.tags.highway))) {
      protectedNodes.add(node); continue;
    }
    if (edges.length < 3 || !edges.some((e) => memberships[e.id]?.length)) continue;
    const candidates = edges.filter(eligible), major = candidates.filter((e) => !minorClass(e.way.tags.highway));
    // Existing arterial intersections keep their original street signature.
    // One-way local street grids (station approaches) need junction handling
    // too, but use a smaller contraction span; two-way alleys stay excluded.
    const local = new Set(major.map((e) => roadFamily(e.way.tags.name))).size >= 2 ? major : candidates;
    const names = [...new Set(local.map((e) => roadFamily(e.way.tags.name)))].sort();
    if (names.length < 2) continue;
    const edge = local[0];
    const signature = names.map((name) => `${name}:${[...new Set(local.filter((e) => roadFamily(e.way.tags.name) === name)
      .map((e) => minorClass(e.way.tags.highway) ? "local" : e.way.tags.highway.replace(/_link$/, "")))].sort().join(",")}`).join("\0");
    seeds.push({ node, point: edge.from === node ? edge.a : edge.b, names, signature,
      span: local.some((e) => minorClass(e.way.tags.highway)) ? 25 : 55 });
  }
  const seedByNode = new Map(seeds.map((s) => [s.node, s]));
  const claimed = new Set<number>();
  const junctions: Junction[] = [];
  for (const seed of seeds) {
    if (claimed.has(seed.node)) continue;
    const signature = seed.signature;
    const parents = new Map<number, number>([[seed.node, seed.node]]);
    const distances = new Map<number, number>([[seed.node, 0]]);
    const pending = [seed.node];
    const reached = new Map<number, Seed>();
    while (pending.length) {
      pending.sort((a, b) => distances.get(b)! - distances.get(a)!);
      const node = pending.pop()!;
      const otherSeed = seedByNode.get(node);
      if (otherSeed) {
        // Do not walk THROUGH a neighbouring intersection to reach a lane.
        if (otherSeed.signature !== signature) continue;
        reached.set(node, otherSeed);
      }
      for (const id of graph.adjacency.get(node) ?? []) {
        const edge = graph.edges[id];
        if (!eligible(edge) || !seed.names.includes(roadFamily(edge.way.tags.name))) continue;
        const next = edge.from === node ? edge.to : edge.from;
        const point = edge.from === node ? edge.b : edge.a;
        const distance = distances.get(node)! + edge.length;
        if (claimed.has(next) || protectedNodes.has(next) || haversineMeters(seed.point, point) > seed.span || distance > seed.span * 2 || distance >= (distances.get(next) ?? Infinity)) continue;
        distances.set(next, distance); parents.set(next, node); pending.push(next);
      }
    }
    const cluster = [seed];
    for (const other of reached.values()) if (other.node !== seed.node && cluster.every((s) => haversineMeters(s.point, other.point) <= seed.span)) cluster.push(other);
    const nodes = new Set<number>();
    for (const end of cluster) {
      let node = end.node;
      while (!nodes.has(node)) { nodes.add(node); const parent = parents.get(node)!; if (parent === node) break; node = parent; }
    }
    const center = { lat: cluster.reduce((s, p) => s + p.point.lat, 0) / cluster.length, lon: cluster.reduce((s, p) => s + p.point.lon, 0) / cluster.length };
    // Hard movement bound; long traffic islands are real roads, not junctions.
    if ([...nodes].some((node) => {
      const edge = graph.edges[graph.adjacency.get(node)![0]];
      return haversineMeters(center, edge.from === node ? edge.a : edge.b) > 40;
    })) continue;
    for (const node of nodes) claimed.add(node);
    junctions.push({ center, radius: Math.max(...cluster.map((s) => haversineMeters(s.point, center))), level: "0|no|no", names: seed.names, nodes: [...nodes], coreNodes: [...nodes], turns: [] });
  }
  // A turning island is bounded by real slip roads. Absorb a slip road only
  // when BOTH ends are reachable on this junction's own streets, without
  // passing through another intersection. This replaces the old circle pull.
  type IslandArc = ReferenceWay & { edgeIds: Set<string> };
  const slips: IslandArc[] = [];
  for (const way of graph.ways) {
    const unnamedLocalTurn = !way.tags.name && minorClass(way.tags.highway)
      && /^(yes|1|-1)$/.test(way.tags.oneway ?? "");
    if (!/^(primary|secondary|tertiary|residential|unclassified|service|busway)(?:_link)?$/.test(way.tags.highway)
      || (minorClass(way.tags.highway) && !/^(yes|1|-1)$/.test(way.tags.oneway ?? ""))
      || !(way.tags.name || way.tags.highway.endsWith("_link") || unnamedLocalTurn)
      || (way.tags.bridge && way.tags.bridge !== "no") || (way.tags.tunnel && way.tags.tunnel !== "no") || (way.tags.layer && way.tags.layer !== "0")) continue;
    let start = -1;
    for (let i = 0; i < way.nodes.length; i++) {
      if ((graph.adjacency.get(way.nodes[i])?.length ?? 0) < 3) continue;
      if (start >= 0) {
        const geometry = way.geometry.slice(start, i + 1);
        const length = geometry.slice(1).reduce((total, point, index) => total + haversineMeters(geometry[index], point), 0);
        if ((!unnamedLocalTurn || length <= 60)
          && geometry.every((p) => haversineMeters(geometry[0], p) <= (unnamedLocalTurn ? 45 : 110))) slips.push({ ...way, geometry,
          nodes: way.nodes.slice(start, i + 1), edgeIds: new Set(Array.from({ length: i - start }, (_, n) => `${way.id}:${start + n}`)) });
      }
      start = i;
    }
  }
  const slipIndex = new SegmentGridIndex(100);
  slips.forEach((way, index) => slipIndex.add({ a: way.geometry[0], b: way.geometry[0], owner: String(index) }));
  const owner = new Map(junctions.flatMap((j) => j.nodes.map((node) => [node, j] as const)));
  for (const junction of junctions) {
    const candidates: IslandArc[] = [];
    slipIndex.findNearby(junction.center, 250, (segment) => {
      candidates.push(slips[Number(segment.owner)]);
      return false;
    });
    const nearby = candidates.filter((way) => (!way.tags.name || junction.names.includes(roadFamily(way.tags.name)))
      && way.geometry.every((p) => haversineMeters(junction.center, p) <= 110));
    if (!nearby.length) continue;
    const reach = (excludedEdges?: Set<string>) => {
      const parent = new Map(junction.nodes.map((node) => [node, node]));
      const queue = [...junction.nodes];
      for (let i = 0; i < queue.length; i++) {
        const node = queue[i];
        for (const id of graph.adjacency.get(node) ?? []) {
          const edge = graph.edges[id];
          if (excludedEdges?.has(edge.id) || !eligible(edge) || !junction.names.includes(roadFamily(edge.way.tags.name))) continue;
          const next = edge.from === node ? edge.to : edge.from;
          const seed = seedByNode.get(next);
          if (parent.has(next) || protectedNodes.has(next) || (owner.has(next) && owner.get(next) !== junction)
            || seed?.names.some((name) => !junction.names.includes(name))
            || haversineMeters(junction.center, edge.from === node ? edge.b : edge.a) > 110) continue;
          parent.set(next, node); queue.push(next);
        }
      }
      return parent;
    };
    const nodes = new Set(junction.nodes);
    for (const way of nearby) {
      // A named turning lane may be tagged as an ordinary street. Require a
      // second path through the core WITHOUT this way: a real local cycle,
      // never a dangling approach or an arbitrary short road segment.
      const parent = reach(way.edgeIds);
      if (!parent.has(way.nodes[0]) || !parent.has(way.nodes.at(-1)!)
        || way.nodes.some((node) => protectedNodes.has(node) || (owner.has(node) && owner.get(node) !== junction))) continue;
      junction.turns.push({ nodes: way.nodes, edgeIds: [...way.edgeIds] });
      // Keep the native small-island diagnostic, but large slip lanes are
      // rerouted along corridor arms, never collapsed into a distant point.
      if (way.geometry.some((p) => haversineMeters(junction.center, p) > 55)) continue;
      for (const end of [way.nodes[0], way.nodes.at(-1)!]) {
        let node = end;
        while (!nodes.has(node)) { nodes.add(node); node = parent.get(node)!; }
      }
      for (const node of way.nodes) nodes.add(node);
    }
    for (const node of nodes) owner.set(node, junction);
    junction.nodes = [...nodes];
  }
  // A single ordinary intersection needs no displacement. Keep a singleton seed
  // only if native turning-island paths actually expanded its component.
  return junctions.filter((junction) => junction.nodes.length > 1 || junction.turns.length);
}
