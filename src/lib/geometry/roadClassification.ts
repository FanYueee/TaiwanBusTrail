import type { ReferenceRoadGraph, ReferenceWay } from "./referenceRoads";
import { cumulativeLengths, projectPointOnSegment } from "./distance";
import { SegmentGridIndex } from "./spatialIndex";

const oneWay = (way: ReferenceWay) => /^(yes|1|-1)$/.test(way.tags.oneway ?? "");
const separated = (way: ReferenceWay) => (way.tags.bridge && way.tags.bridge !== "no")
  || (way.tags.tunnel && way.tags.tunnel !== "no") || (way.tags.layer && way.tags.layer !== "0");
const stationName = (name: string) => /站區|轉運站.*行車|車站.*專用/.test(name);
const localAccess = (way: ReferenceWay) => /^(service|unclassified)$/.test(way.tags.highway);

export interface RoadClassification {
  mainline: Set<string>;
  stationAccess: Set<string>;
}

/** Classify physical corridors from OSM attributes and connected access roads.
 * No route ID, county, road ref, or geographic coordinate participates.
 */
export function classifyRoadGraph(graph: ReferenceRoadGraph): RoadClassification {
  const fastNodes = new Set(graph.ways.filter((way) => /^(motorway|trunk)$/.test(way.tags.highway)).flatMap((way) => way.nodes));
  const corridor = new Map<string, { length: number; separatedLength: number; mainlineContinuation: boolean }>();
  for (const way of graph.ways) {
    const length = cumulativeLengths(way.geometry).at(-1) ?? 0;
    if (way.tags.highway !== "primary" || !oneWay(way) || !way.tags.ref || !way.tags.name) continue;
    const key = `${way.tags.ref}\0${way.tags.name}`;
    const row = corridor.get(key) ?? { length: 0, separatedLength: 0, mainlineContinuation: false };
    row.length += length;
    row.mainlineContinuation ||= way.nodes.some((node) => fastNodes.has(node));
    if (separated(way)) {
      row.separatedLength += length;
    }
    corridor.set(key, row);
  }
  const expresswayGroups = new Set([...corridor].filter(([, row]) => row.separatedLength >= 5000
    && (row.separatedLength / row.length >= .75 || row.mainlineContinuation)).map(([key]) => key));
  const mainline = new Set<string>();
  const stationAccess = new Set<string>();
  const stationNodes = new Set<number>();
  const stationRoads = new SegmentGridIndex(100);
  for (const edge of graph.edges) {
    const way = edge.way, tags = way.tags;
    if (/^(motorway|trunk)$/.test(tags.highway)
      || (tags.highway === "primary" && oneWay(way) && expresswayGroups.has(`${tags.ref}\0${tags.name}`))) mainline.add(edge.id);
    if ((tags.name && stationName(tags.name)) || (localAccess(way) && (tags.service === "bus" || tags.bus === "designated"))) {
      stationAccess.add(edge.id);
      stationNodes.add(edge.from);
      stationNodes.add(edge.to);
    }
    if (tags.highway === "service" && edge.length <= 180) stationRoads.add({ a: edge.a, b: edge.b, owner: edge.id });
  }
  const byId = new Map(graph.edges.map((edge) => [edge.id, edge]));
  for (const station of graph.stations) {
    const nearby = new Map<string, number>();
    stationRoads.findNearby(station, 90, (candidate) => {
      const distance = projectPointOnSegment(station, candidate.a, candidate.b).distanceMeters;
      if (distance <= 90) nearby.set(candidate.owner!, Math.min(distance, nearby.get(candidate.owner!) ?? Infinity));
      return false;
    });
    const closest = Math.min(Infinity, ...nearby.values());
    for (const [id, distance] of nearby) {
      if (distance > closest + 10) continue;
      const edge = byId.get(id)!;
      stationAccess.add(edge.id);
      stationNodes.add(edge.from);
      stationNodes.add(edge.to);
    }
  }
  const pending = [...stationNodes].map((node) => ({ node, distance: 0 }));
  const seen = new Map(pending.map(({ node }) => [node, 0]));
  for (let i = 0; i < pending.length; i++) {
    const { node, distance } = pending[i];
    if (distance !== seen.get(node)) continue;
    for (const id of graph.adjacency.get(node) ?? []) {
      const edge = graph.edges[id];
      if (!localAccess(edge.way)) continue;
      const next = edge.from === node ? edge.to : edge.from;
      const length = distance + edge.length;
      if (length > 120) continue;
      stationAccess.add(edge.id);
      if (length >= (seen.get(next) ?? Infinity)) continue;
      seen.set(next, length);
      pending.push({ node: next, distance: length });
    }
  }
  return { mainline, stationAccess };
}
