import type { LatLon } from "../types";
import type { RoadNetworkChain } from "./roadNetwork";
import type { ReferenceEdge, ReferenceRoadGraph, RoadRange } from "./referenceRoads";
import { cumulativeLengths, haversineMeters, headingDifferenceRadians, interpolate, projectPointOnSegment, segmentHeadingRadians } from "./distance";
import { SegmentGridIndex } from "./spatialIndex";
import { detectRoadJunctions, roadFamily, roadLevel } from "./roadJunctions";
import { classifyRoadGraph } from "./roadClassification";

interface Spine {
  ramp: boolean;
  radius: number;
  radii: number[];
  flows: number[];
  priority: number;
  levels: string[];
  nativeCenters: boolean[];
  road: string;
  group: string;
  points: LatLon[];
  cumulative: number[];
  index: SegmentGridIndex;
  center: LatLon[];
  distances: number[];
  ranges: { from: number; to: number; keys: string[]; source: string }[];
  anchors: { from: number; to: number; point: LatLon }[];
  warp: { along: number; lat: number; lon: number }[];
  resolved?: { distances: number[]; points: LatLon[] };
}
interface Position { spine: number; along: number }
export interface RoadDisplayStats {
  completedGaps: number; completedGapEdges: number; reroutedTurns?: number;
  contractedLocalTurns?: number;
  corridorReversals?: number;
  regularizedCorridors?: number;
  smoothedRampWays?: number;
  smoothedLocalWays?: number;
  inferredSideWays?: number;
  pairedRampCorridors?: number;
  anchorConflicts?: number;
  anchorConflictExamples?: { road: string; sources: string[]; first: Spine["anchors"][number]; second: Spine["anchors"][number]; meters: number }[];
  reversalExamples?: { road: string; meters: number; point: LatLon }[];
}
export interface RoadDisplayDiagnostics {
  spines?: { road: string; reference: LatLon[]; center: LatLon[]; anchors: Spine["anchors"]; sources: string[] }[];
  includeSpines?: boolean;
  constraints?: { nodes: number[]; references: LatLon[]; point: LatLon; masterRoad: string }[];
  includeConstraints?: boolean;
  positionShifts?: { node: number; native: LatLon; display: LatLon; meters: number; roads: string[] }[];
  includePositionShifts?: boolean;
  collapsedRanges?: string[];
}
const rampPairRadius = 35;
const corridorRadius = (highway: string) => /^(service|busway)$/.test(highway) ? 20
  : highway === "residential" ? 35 : highway === "unclassified" ? 58 : highway === "secondary" ? 55 : 90;
const groupOf = (edge: ReferenceEdge, protectedEdges: Set<string>): string | null => {
  const tags = edge.way.tags;
  // Expressway and motorway carriageways must retain one line per direction.
  if (protectedEdges.has(edge.id)) return null;
  if (tags.junction === "roundabout") return null;
  if (!tags.name || !/^(motorway|primary|secondary|tertiary|trunk|residential|unclassified|service|busway|secondary_link|tertiary_link|motorway_link|trunk_link)$/.test(tags.highway)) return null;
  // Ramp pairs have their own narrow, counterflow-only corridor rules. They
  // never enter the through-road's family merely because a name matches.
  if (/^(motorway_link|trunk_link)$/.test(tags.highway)) return `${roadFamily(tags.name)}#ramp`;
  // A two-way OSM street already is a road centreline. A nearby divided road
  // with the same name is not evidence that this street is another carriageway.
  // Bridges are the exception: older mapped parallel bridge decks often omit
  // oneway, and still carry explicit grade and bridge identity.
  if (/^(residential|unclassified|service)$/.test(tags.highway)
    && !/^(yes|1|-1)$/.test(tags.oneway ?? "") && (!tags.bridge || tags.bridge === "no")) return null;
  // Short named intersection slip lanes belong to their street; highway ramps do not.
  if (tags.highway.endsWith("_link") && (!tags.bridge || tags.bridge === "no")
    && cumulativeLengths(edge.way.geometry).at(-1)! > 120) return null;
  // Trace a continuous street through bridge/ground tag boundaries. Pairing still
  // checks the LOCAL level, so an overpass cannot merge with the street beneath it.
  return roadFamily(tags.name);
};

function project(spine: Spine, point: LatLon) {
  let result: { distance: number; along: number; heading: number; flow: number; level: string } | null = null;
  const seen = new Set<number>();
  spine.index.findNearby(point, spine.radius, (segment) => {
    const i = Number(segment.owner);
    if (seen.has(i)) return false;
    seen.add(i);
    const projection = projectPointOnSegment(point, segment.a, segment.b);
    if (projection.distanceMeters <= spine.radii[i] && (!result || projection.distanceMeters < result.distance)) {
      result = { distance: projection.distanceMeters, along: spine.cumulative[i] + projection.t * (spine.cumulative[i + 1] - spine.cumulative[i]), heading: segment.headingRadians, flow: spine.flows[i], level: spine.levels[i] };
    }
    return false;
  });
  return result as { distance: number; along: number; heading: number; flow: number; level: string } | null;
}

const trafficHeading = (edge: ReferenceEdge) => segmentHeadingRadians(edge.a, edge.b) + (edge.way.tags.oneway === "-1" ? Math.PI : 0);

function pointAt(points: LatLon[], distances: number[], along: number): LatLon {
  let low = 0, high = distances.length - 1;
  while (low + 1 < high) { const mid = (low + high) >> 1; if (distances[mid] <= along) low = mid; else high = mid; }
  const span = distances[high] - distances[low];
  return interpolate(points[low], points[high], span > 0 ? Math.max(0, Math.min(1, (along - distances[low]) / span)) : 0);
}

/** Display-only corridor graph. Native OSM topology and matching remain unchanged.
 * Dual carriageways merge only with equal name, elevation and road class eligibility.
 * A fixed reference spine is used throughout; no TDX geometry participates in display construction.
 */
export function buildRoadDisplay(nativeGraph: ReferenceRoadGraph, memberships: Record<string, string[]>, matchedRanges?: Record<string, RoadRange[]>, stats?: RoadDisplayStats, diagnostics?: RoadDisplayDiagnostics): RoadNetworkChain[] {
  if (stats) { stats.corridorReversals = 0; stats.anchorConflicts = 0; }
  const graph = nativeGraph;
  const classification = classifyRoadGraph(graph);
  const protectedEdges = new Set([...classification.mainline, ...classification.stationAccess]);
  const metersLon = 111320 * Math.max(.01, Math.cos((graph.edges[0]?.a.lat ?? 0) * Math.PI / 180));
  const fastRoadNodes = new Map<number, LatLon>();
  const fastRoadSegments = new SegmentGridIndex(100);
  const nativeNodePositions = new Map<number, LatLon>();
  for (const edge of graph.edges) {
    nativeNodePositions.set(edge.from, edge.a);
    nativeNodePositions.set(edge.to, edge.b);
  }
  for (const edge of graph.edges) if (classification.mainline.has(edge.id)) {
    fastRoadNodes.set(edge.from, edge.a);
    fastRoadNodes.set(edge.to, edge.b);
    fastRoadSegments.add({ a: edge.a, b: edge.b, owner: roadLevel(edge) });
  }
  const crossesFastRoad = (a: LatLon, b: LatLon, level: string) => {
    const length = haversineMeters(a, b);
    if (length < 2) return false;
    return fastRoadSegments.findNearby(interpolate(a, b, .5), length / 2 + 2, (segment) => {
      if (segment.owner !== level) return false;
      const rx = (b.lon - a.lon) * metersLon, ry = (b.lat - a.lat) * 110574;
      const sx = (segment.b.lon - segment.a.lon) * metersLon, sy = (segment.b.lat - segment.a.lat) * 110574;
      const denominator = rx * sy - ry * sx;
      if (Math.abs(denominator) < .001) return false;
      const qx = (segment.a.lon - a.lon) * metersLon, qy = (segment.a.lat - a.lat) * 110574;
      const along = (qx * sy - qy * sx) / denominator;
      const across = (qx * ry - qy * rx) / denominator;
      return along > .02 && along < .98 && across >= 0 && across <= 1;
    });
  };
  const junctions = detectRoadJunctions(graph, memberships);
  const junctionNodes = new Map<number, LatLon>();
  const groups = new Map<string, number[]>();
  const mainlineRampGroups = new Set<string>();
  for (const way of graph.ways) if (/^(motorway_link|trunk_link)$/.test(way.tags.highway)
    && way.tags.name && way.nodes.some((node) => fastRoadNodes.has(node))) {
    mainlineRampGroups.add(`${roadFamily(way.tags.name)}#ramp`);
  }
  for (let i = 0; i < graph.edges.length; i++) {
    const group = groupOf(graph.edges[i], protectedEdges);
    if (group && !mainlineRampGroups.has(group)) {
      const list = groups.get(group) ?? []; list.push(i); groups.set(group, list);
    }
  }
  const spines: Spine[] = [];
  const assignments = new Map<number, { spine: number; from: number; to: number }>();
  const nodePositions = new Map<number, Position[]>();
  const remember = (node: number, value: Position) => {
    const positions = nodePositions.get(node) ?? [];
    if (!positions.some((p) => p.spine === value.spine && Math.abs(p.along - value.along) < .001)) positions.push(value);
    nodePositions.set(node, positions);
  };
  for (const [group, ids] of groups) {
    const ramp = group.endsWith("#ramp");
    if (!ids.some((id) => memberships[graph.edges[id].id])) continue;
    if (!ids.some((id) => /^(yes|1|-1)$/.test(graph.edges[id].way.tags.oneway ?? ""))
      && !(ids.every((id) => graph.edges[id].way.tags.bridge && graph.edges[id].way.tags.bridge !== "no")
        && new Set(ids.map((id) => graph.edges[id].way.id)).size > 1)) continue;
    const adjacency = new Map<number, number[]>();
    const spatial = new SegmentGridIndex(100);
    for (const id of ids) {
      const edge = graph.edges[id];
      spatial.add({ a: edge.a, b: edge.b, owner: String(id) });
      for (const node of [edge.from, edge.to]) { const bucket = adjacency.get(node) ?? []; bucket.push(id); adjacency.set(node, bucket); }
    }
    const used = new Set<number>();
    const chains: { points: LatLon[]; ids: number[]; length: number }[] = [];
    const walk = (first: number, start: number) => {
      const points: LatLon[] = [], members: number[] = [];
      let id = first, node = start, length = 0;
      for (;;) {
        if (used.has(id)) break;
        used.add(id); members.push(id);
        const edge = graph.edges[id];
        const forward = edge.from === node;
        if (!points.length) points.push(forward ? edge.a : edge.b);
        points.push(forward ? edge.b : edge.a); length += edge.length;
        node = forward ? edge.to : edge.from;
        // Stop a ramp stroke at a real merge/diverge node. Otherwise a greedy
        // walk can travel through an interchange and consume BOTH opposite
        // ramps as one giant loop before pairing is even attempted.
        if (ramp && (graph.adjacency.get(node)?.length ?? 0) !== 2) break;
        const next = adjacency.get(node) ?? [];
        const heading = segmentHeadingRadians(points[points.length - 2], points[points.length - 1]);
        const candidate = next.filter((other) => !used.has(other)).map((other) => {
          const segment = graph.edges[other];
          const end = segment.from === node ? segment.b : segment.a;
          return { id: other, straightness: Math.cos(segmentHeadingRadians(points[points.length - 1], end) - heading) };
        }).filter((option) => option.straightness > .5)
          .sort((a, b) => b.straightness - a.straightness)[0]?.id;
        if (candidate === undefined) break;
        if (!ramp && length > 120 && graph.edges[candidate].length >= 8
          && /^(yes|1|-1)$/.test(graph.edges[candidate].way.tags.oneway ?? "")) {
          const nextEdge = graph.edges[candidate];
          const end = nextEdge.from === node ? nextEdge.b : nextEdge.a;
          const nextHeading = segmentHeadingRadians(points.at(-1)!, end);
          const middle = interpolate(points.at(-1)!, end, .5);
          const returnLane = members.slice(0, -2).some((earlier, i) => {
            if (!/^(yes|1|-1)$/.test(graph.edges[earlier].way.tags.oneway ?? "")
              || roadLevel(graph.edges[earlier]) !== roadLevel(nextEdge)
              || haversineMeters(points[i], points[i + 1]) < 15
              || Math.cos(nextHeading - segmentHeadingRadians(points[i], points[i + 1])) > -.94) return false;
            const projection = projectPointOnSegment(middle, points[i], points[i + 1]);
            return projection.distanceMeters <= Math.min(35, corridorRadius(nextEdge.way.tags.highway))
              && projection.t > .05 && projection.t < .95;
          });
          if (returnLane) break;
        }
        id = candidate;
      }
      chains.push({ points, ids: members, length });
    };
    for (const id of ids) {
      const edge = graph.edges[id];
      if (!used.has(id) && (ramp ? graph.adjacency : adjacency).get(edge.from)!.length !== 2) walk(id, edge.from);
      if (!used.has(id) && (ramp ? graph.adjacency : adjacency).get(edge.to)!.length !== 2) walk(id, edge.to);
    }
    for (const id of ids) if (!used.has(id)) walk(id, graph.edges[id].from);
    chains.sort((a, b) => b.length - a.length);
    for (const chain of chains) {
      // Short named bridges still need a centreline. Length is not a reason to
      // leave their two carriageways disconnected from the approaches.
      if (chain.ids.every((id) => assignments.has(id)) || chain.length < 15) continue;
      if (chain.length < 120 && !chain.ids.some((id) => graph.edges[id].way.tags.bridge && graph.edges[id].way.tags.bridge !== "no")) {
        // A short station approach can be a real divided road. Only admit a
        // straight, well-supported local stroke: short curved turn islands
        // must remain junction candidates, not become competing spines.
        if (!chain.ids.every((id) => /^(residential|unclassified)$/.test(graph.edges[id].way.tags.highway))) continue;
        const heading = segmentHeadingRadians(chain.points[0], chain.points.at(-1)!);
        if (chain.points.slice(1).some((p, i) => Math.cos(segmentHeadingRadians(chain.points[i], p) - heading) < .94)) continue;
        const own = new Set(chain.ids.map((id) => graph.edges[id].way.id));
        let supported = 0;
        for (const id of chain.ids) {
          const edge = graph.edges[id], point = interpolate(edge.a, edge.b, .5);
          let overlap = 0;
          spatial.findNearby(point, 20, (candidate) => {
            const other = graph.edges[Number(candidate.owner)];
            if (own.has(other.way.id) || roadLevel(other) !== roadLevel(edge)
              || headingDifferenceRadians(heading, candidate.headingRadians) > Math.PI / 12) return false;
            const p = projectPointOnSegment(point, candidate.a, candidate.b);
            if (p.distanceMeters <= 20 && p.t > 0 && p.t < 1) overlap = Math.max(overlap, Math.min(edge.length, other.length));
            return false;
          });
          supported += overlap;
        }
        if (supported < chain.length * .9) continue;
      }
      // If another spine already represents most of this carriageway, don't create a competing one.
      const represented = chain.ids.reduce((sum, id) => sum + (assignments.has(id) ? graph.edges[id].length : 0), 0);
      if (represented > chain.length * .7) continue;
      if (ramp) {
        // A single ramp still uses its native curve and long endpoint blend.
        // Require sustained evidence of a separate, opposing parallel ramp;
        // proximity to another arm of the SAME loop is not evidence of a pair.
        const own = new Set(chain.ids.map((id) => graph.edges[id].way.id));
        let pairedLength = 0;
        for (const id of chain.ids) {
          const edge = graph.edges[id], point = interpolate(edge.a, edge.b, .5);
          let overlap = 0;
          spatial.findNearby(point, rampPairRadius, (candidate) => {
            const other = graph.edges[Number(candidate.owner)];
            if (own.has(other.way.id) || roadLevel(other) !== roadLevel(edge)
              || Math.cos(trafficHeading(edge) - trafficHeading(other)) > -.94) return false;
            const p = projectPointOnSegment(point, candidate.a, candidate.b);
            if (p.distanceMeters <= rampPairRadius && p.t > 0 && p.t < 1) overlap = Math.max(overlap, Math.min(edge.length, other.length));
            return false;
          });
          pairedLength += overlap;
        }
        if (pairedLength < 60) continue;
      }
      const rank = (highway: string) => ({ trunk: 6, primary: 5, secondary: 4, tertiary: 3, unclassified: 2, residential: 1 }[highway] ?? 0);
      const shortLocal = chain.length < 120 && chain.ids.every((id) => /^(residential|unclassified)$/.test(graph.edges[id].way.tags.highway));
      const radii = chain.ids.map((id) => ramp ? rampPairRadius : shortLocal ? 20 : corridorRadius(graph.edges[id].way.tags.highway));
      const spine: Spine = { ramp, radius: Math.max(...radii), radii,
        flows: chain.ids.map((id) => trafficHeading(graph.edges[id])),
        priority: Math.max(...chain.ids.map((id) => rank(graph.edges[id].way.tags.highway))) * 1e7 + chain.length, group, levels: chain.ids.map((id) => roadLevel(graph.edges[id])),
        nativeCenters: chain.ids.map((id) => !/^(yes|1|-1)$/.test(graph.edges[id].way.tags.oneway ?? "") && roadLevel(graph.edges[id]) === "0|no|no"),
        road: graph.edges[chain.ids[0]].way.tags.name, points: chain.points, cumulative: cumulativeLengths(chain.points), index: new SegmentGridIndex(100), center: [], distances: [], ranges: [], anchors: [], warp: [] };
      chain.points.slice(1).forEach((point, i) => spine.index.add({ a: chain.points[i], b: point, owner: String(i) }));
      const spineId = spines.length; spines.push(spine);
      if (ramp && stats) stats.pairedRampCorridors = (stats.pairedRampCorridors ?? 0) + 1;
      // An edge on the reference stroke has an exact position. Spatially
      // projecting it onto itself can jump to a nearby hairpin or station loop.
      chain.ids.forEach((id, i) => {
        if (assignments.has(id)) return;
        const edge = graph.edges[id];
        const forward = haversineMeters(edge.a, chain.points[i]) < .1;
        const from = spine.cumulative[forward ? i : i + 1], to = spine.cumulative[forward ? i + 1 : i];
        assignments.set(id, { spine: spineId, from, to });
        remember(edge.from, { spine: spineId, along: from }); remember(edge.to, { spine: spineId, along: to });
      });
      for (const id of ids) {
        if (assignments.has(id)) continue;
        const edge = graph.edges[id];
        const a = project(spine, edge.a), b = project(spine, edge.b);
        const middle = project(spine, interpolate(edge.a, edge.b, .5));
        if (middle?.level !== roadLevel(edge)) continue;
        if (ramp && Math.cos(trafficHeading(edge) - middle.flow) > -.94) continue;
        if (!a || !b || a.distance > corridorRadius(edge.way.tags.highway) || b.distance > corridorRadius(edge.way.tags.highway)
          || Math.abs(a.along - b.along) < edge.length * .65 || Math.abs(a.along - b.along) > edge.length * 1.4) continue;
        // A long straight lane may start beside a tiny intersection taper.
        // Its midpoint gives the actual corridor tangent, not that taper's turn.
        if (headingDifferenceRadians(segmentHeadingRadians(edge.a, edge.b), middle.heading) > Math.PI / 9) continue;
        if (crossesFastRoad(interpolate(edge.a, edge.b, .5), pointAt(spine.points, spine.cumulative, middle.along), roadLevel(edge))) continue;
        assignments.set(id, { spine: spineId, from: a.along, to: b.along });
        remember(edge.from, { spine: spineId, along: a.along }); remember(edge.to, { spine: spineId, along: b.along });
      }
      const total = spine.cumulative[spine.cumulative.length - 1];
      const offsets: number[] = [];
      const headings: number[] = [];
      const fixedCenters: boolean[] = [];
      const base: LatLon[] = [];
      const count = Math.max(1, Math.ceil(total / 15));
      const samples = Array.from({ length: count + 1 }, (_, i) => total * i / count);
      for (const along of samples) {
        const point = pointAt(spine.points, spine.cumulative, along);
        const before = pointAt(spine.points, spine.cumulative, Math.max(0, along - 5));
        const after = pointAt(spine.points, spine.cumulative, Math.min(total, along + 5));
        const heading = segmentHeadingRadians(before, after);
        let nativeSegment = 0;
        while (nativeSegment + 1 < spine.levels.length && spine.cumulative[nativeSegment + 1] < along) nativeSegment++;
        fixedCenters.push(spine.nativeCenters[nativeSegment]);
        let left = 0, right = 0;
        const seen = new Set<number>();
        spatial.findNearby(point, spine.radii[nativeSegment], (segment) => {
          const id = Number(segment.owner);
          // Geometry must not depend on which greedy stroke happened to claim
          // the opposite lane first. Otherwise every stroke hand-off shifts the
          // road sideways (especially around station approaches).
          if (seen.has(id) || roadLevel(graph.edges[id]) !== spine.levels[nativeSegment]) return false;
          seen.add(id);
          if (ramp && Math.cos(trafficHeading(graph.edges[id]) - spine.flows[nativeSegment]) > -.94) return false;
          if (headingDifferenceRadians(heading, segment.headingRadians) > Math.PI / 12) return false;
          const projection = projectPointOnSegment(point, segment.a, segment.b);
          if (projection.distanceMeters > Math.min(spine.radii[nativeSegment], corridorRadius(graph.edges[id].way.tags.highway))) return false;
          if (crossesFastRoad(point, projection.closest, spine.levels[nativeSegment])) return false;
          const dx = (projection.closest.lon - point.lon) * metersLon;
          const dy = (projection.closest.lat - point.lat) * 110574;
          // Only a real cross-section can establish road width. A nearby
          // segment END beyond a bend is not a parallel carriageway here.
          if ((projection.t < 1e-8 || projection.t > 1 - 1e-8)
            && Math.abs(dx * Math.sin(heading) + dy * Math.cos(heading)) > 2) return false;
          const offset = dx * Math.cos(heading) - dy * Math.sin(heading);
          left = Math.min(left, offset); right = Math.max(right, offset);
          return false;
        });
        offsets.push((left + right) / 2); headings.push(heading); base.push(point); spine.distances.push(along);
      }
      const medians = offsets.map((_, i) => {
        const window = offsets.slice(Math.max(0, i - 3), Math.min(offsets.length, i + 4)).sort((a, b) => a - b);
        return window[Math.floor(window.length / 2)];
      });
      spine.center = base.map((point, i) => {
        if (fixedCenters[i]) return point;
        let sum = 0, weights = 0;
        for (let j = Math.max(0, i - 3); j <= Math.min(medians.length - 1, i + 3); j++) {
          const weight = 4 - Math.abs(j - i); sum += medians[j] * weight; weights += weight;
        }
        const offset = sum / weights;
        return { lat: point.lat - offset * Math.sin(headings[i]) / 110574, lon: point.lon + offset * Math.cos(headings[i]) / metersLon };
      });
    }
  }
  // Unnamed one-way side lanes can be part of a divided street (OSM often
  // omits their name). Infer only with two native cross-section connections,
  // a unique corridor and a dense, monotone same-grade parallel match. Nearby
  // disconnected streets, two-way alleys and ramps are deliberately excluded.
  const spineSpatial = new SegmentGridIndex(100);
  spines.forEach((s, id) => s.points.slice(1).forEach((b, i) => spineSpatial.add({ a: s.points[i], b, owner: String(id) })));
  const edgeIndexes = new Map(graph.edges.map((e, id) => [e.id, id]));
  for (const way of graph.ways) {
    if (way.tags.name || way.tags.highway !== "unclassified" || !/^(yes|1|-1)$/.test(way.tags.oneway ?? "")) continue;
    const ids = way.nodes.slice(1).map((_, i) => edgeIndexes.get(`${way.id}:${i}`)).filter((id) => id !== undefined);
    if (!ids.length || ids.some((id) => assignments.has(id)) || !ids.some((id) => memberships[graph.edges[id].id]?.length)) continue;
    const distances = cumulativeLengths(way.geometry), total = distances.at(-1)!;
    if (total < 30) continue;
    const candidates = new Set<number>();
    spineSpatial.findNearby(pointAt(way.geometry, distances, total / 2), 45, (s) => { candidates.add(Number(s.owner)); return false; });
    const accepted: { spine: number; positions: number[] }[] = [];
    for (const id of candidates) {
      const spine = spines[id], projections = way.geometry.map((p) => project(spine, p));
      if (spine.ramp) continue;
      if (projections.some((p) => !p || p.distance > 45)) continue;
      const positions = projections.map((p) => p!.along), span = positions.at(-1)! - positions[0];
      if (Math.abs(span) < total * .8 || Math.abs(span) > total * 1.25) continue;
      const level = roadLevel(graph.edges[ids[0]]);
      let valid = true;
      for (let i = 1; i < way.geometry.length && valid; i++) {
        if ((positions[i] - positions[i - 1]) * span <= 0) { valid = false; break; }
        const heading = segmentHeadingRadians(way.geometry[i - 1], way.geometry[i]);
        const steps = Math.max(1, Math.ceil((distances[i] - distances[i - 1]) / 15));
        for (let step = 0; step <= steps; step++) {
          const p = project(spine, interpolate(way.geometry[i - 1], way.geometry[i], step / steps));
          if (!p || p.level !== level || p.distance > 45 || headingDifferenceRadians(heading, p.heading) > Math.PI / 9) { valid = false; break; }
        }
      }
      if (!valid) continue;
      const connected = (start: number, along: number, heading: number) => {
        const queue = [{ node: start, distance: 0 }], seen = new Set<number>([start]);
        for (let i = 0; i < queue.length; i++) {
          const { node, distance } = queue[i];
          if ((nodePositions.get(node) ?? []).some((p) => p.spine === id && Math.abs(p.along - along) < 30)) return true;
          for (const edgeId of graph.adjacency.get(node) ?? []) {
            const edge = graph.edges[edgeId], next = edge.from === node ? edge.to : edge.from;
            if (seen.has(next) || edge.way.id === way.id || roadLevel(edge) !== level || edge.way.tags.highway.endsWith("_link")
              || distance + edge.length > 65 || headingDifferenceRadians(heading, segmentHeadingRadians(edge.a, edge.b)) < Math.PI / 3) continue;
            seen.add(next); queue.push({ node: next, distance: distance + edge.length });
          }
        }
        return false;
      };
      if (connected(way.nodes[0], positions[0], projections[0]!.heading)
        && connected(way.nodes.at(-1)!, positions.at(-1)!, projections.at(-1)!.heading)) accepted.push({ spine: id, positions });
    }
    if (accepted.length !== 1) continue;
    const { spine, positions } = accepted[0];
    ids.forEach((id) => {
      const edge = graph.edges[id], i = Number(edge.id.split(":")[1]);
      assignments.set(id, { spine, from: positions[i], to: positions[i + 1] });
      remember(edge.from, { spine, along: positions[i] }); remember(edge.to, { spine, along: positions[i + 1] });
    });
    if (stats) stats.inferredSideWays = (stats.inferredSideWays ?? 0) + 1;
  }
  // Complete bounded gaps in a carriageway's assignment as a PATH, not one
  // tiny edge at a time. Lane tapers often exceed the per-edge heading gate,
  // leaving an artificial triangle between two already shared corridor points.
  // Both ends must already belong to the same spine, with monotone progress and
  // equal street/elevation throughout. Real branches have no second anchor.
  for (let first = 0; first < graph.edges.length; first++) {
    if (assignments.has(first)) continue;
    const initial = graph.edges[first], group = groupOf(initial, protectedEdges);
    if (!group) continue;
    const positionsAt = (node: number) => (nodePositions.get(node) ?? []).filter((p) => spines[p.spine].group === group);
    const start = positionsAt(initial.from).length ? initial.from : positionsAt(initial.to).length ? initial.to : null;
    if (start === null) continue;
    // A station lane may contain an entrance fork before rejoining the same
    // corridor. Enumerate bounded native paths instead of giving up at the
    // first fork. Dead ends never produce a candidate and are left untouched.
    type GapPath = { ids: number[]; nodes: number[]; points: LatLon[]; length: number };
    const pending: GapPath[] = [{ ids: [], nodes: [start], points: [initial.from === start ? initial.a : initial.b], length: 0 }];
    const paths: GapPath[] = [];
    let visited = 0;
    while (pending.length && visited++ < 64) {
      const path = pending.pop()!, node = path.nodes.at(-1)!;
      const next = path.ids.length ? graph.adjacency.get(node) ?? [] : [first];
      for (const id of next) {
        const edge = graph.edges[id], end = edge.from === node ? edge.to : edge.from;
        if (assignments.has(id) || path.nodes.includes(end) || groupOf(edge, protectedEdges) !== group
          || roadLevel(edge) !== roadLevel(initial) || path.length + edge.length > 100) continue;
        const candidate = { ids: [...path.ids, id], nodes: [...path.nodes, end],
          points: [...path.points, edge.from === node ? edge.b : edge.a], length: path.length + edge.length };
        if (positionsAt(end).length) paths.push(candidate);
        else pending.push(candidate);
      }
    }
    // If the bounded search cannot finish, leave this complex component native.
    if (pending.length) continue;
    paths.sort((a, b) => a.length - b.length);
    for (const { ids, nodes, points, length } of paths) {
      if (ids.some((id) => assignments.has(id))) continue;
      const node = nodes.at(-1)!;
      for (const from of positionsAt(start)) {
        const to = positionsAt(node).find((p) => p.spine === from.spine);
        if (!to) continue;
        const span = to.along - from.along, spine = spines[from.spine];
        // Inner and outer carriageways have different arc lengths at a bend.
        // The dense leash test below, rather than a straight-road 1.4 ratio,
        // decides whether the complete gap stays in the same corridor.
        const shortTurn = length <= 35 && Math.abs(span) >= 1
          && points.every((point) => (project(spine, point)?.distance ?? Infinity) <= 20);
        if ((Math.abs(span) < length * .5 && !shortTurn) || Math.abs(span) > length * 2) continue;
        const projections = points.map((p) => project(spine, p));
        if (projections.some((p) => !p || p.distance > 35)) continue;
        // Independent nearest-point projections can reverse order on offset
        // curves. Use the anchored path's arc length, then verify its leash to
        // the reference. This is monotone by construction, including lane bends.
        const pathDistances = cumulativeLengths(points);
        const along = pathDistances.map((distance) => from.along + span * distance / pathDistances.at(-1)!);
        if (points.some((point, i) => haversineMeters(point, pointAt(spine.points, spine.cumulative, along[i])) > 35)) continue;
        let leashValid = true;
        for (let i = 1; i < points.length; i++) {
          const steps = Math.max(1, Math.ceil((pathDistances[i] - pathDistances[i - 1]) / 5));
          for (let j = 1; j < steps; j++) if (haversineMeters(interpolate(points[i - 1], points[i], j / steps),
            pointAt(spine.points, spine.cumulative, along[i - 1] + (along[i] - along[i - 1]) * j / steps)) > 35) leashValid = false;
        }
        if (!leashValid) continue;
        if (ids.some((edgeId, i) => project(spine, interpolate(points[i], points[i + 1], .5))?.level !== roadLevel(graph.edges[edgeId]))) continue;
        ids.forEach((edgeId, i) => {
          const edge = graph.edges[edgeId], forward = edge.from === nodes[i];
          assignments.set(edgeId, { spine: from.spine, from: along[forward ? i : i + 1], to: along[forward ? i + 1 : i] });
          remember(nodes[i], { spine: from.spine, along: along[i] });
          remember(nodes[i + 1], { spine: from.spine, along: along[i + 1] });
        });
        if (stats) { stats.completedGaps++; stats.completedGapEdges += ids.length; }
        break;
      }
    }
  }
  // Centreline-first junction constraints. Never average an arterial's centre
  // with each separate side-lane endpoint: that pulls a straight road sideways.
  // Resolve coincident/overlapping constraints BEFORE building the deformation;
  // two different target points at the same chainage used to produce spikes.
  const centerIndexes = spines.map((spine) => {
    const index = new SegmentGridIndex(100);
    spine.center.slice(1).forEach((b, i) => index.add({ a: spine.center[i], b, owner: String(i) }));
    return index;
  });
  const centerProjection = (id: number, point: LatLon, hint?: number) => {
    const spine = spines[id];
    let best: { along: number; point: LatLon; distance: number } | undefined;
    centerIndexes[id].findNearby(point, 80, (segment) => {
      const p = projectPointOnSegment(point, segment.a, segment.b), i = Number(segment.owner);
      const along = spine.distances[i] + p.t * (spine.distances[i + 1] - spine.distances[i]);
      if (hint !== undefined && Math.abs(along - hint) > 130) return false;
      if (!best || p.distanceMeters < best.distance) best = { point: p.closest, distance: p.distanceMeters,
        along };
      return false;
    });
    return best;
  };
  type Constraint = { nodes: Set<number>; references: LatLon[]; positions: Map<number, number[]>; point: LatLon };
  const constraints: Constraint[] = [];
  const originalJunctionNodes = new Set(junctions.flatMap((j) => j.coreNodes));
  const addConstraint = (nodes: number[], reference: LatLon) => {
    const positions = new Map<number, number[]>();
    for (const node of nodes) for (const p of nodePositions.get(node) ?? []) {
      const list = positions.get(p.spine) ?? []; list.push(p.along); positions.set(p.spine, list);
    }
    if (!positions.size) { for (const node of nodes) junctionNodes.set(node, reference); return; }
    constraints.push({ nodes: new Set(nodes), references: [reference], positions, point: reference });
  };
  for (const j of junctions) addConstraint(j.coreNodes, j.center);
  for (const [node, positions] of nodePositions) {
    if (positions.length < 2 || originalJunctionNodes.has(node) || fastRoadNodes.has(node)) continue;
    const edge = graph.edges[graph.adjacency.get(node)![0]];
    addConstraint([node], edge.from === node ? edge.a : edge.b);
  }
  // A station loop can visit the same junction at distant chainages. Those
  // are multiple anchors at ONE physical junction, not one enormous interval.
  const positionRuns = (positions: number[]) => {
    const runs: { from: number; to: number }[] = [];
    for (const at of [...new Set(positions)].sort((a, b) => a - b)) {
      const last = runs.at(-1);
      if (!last || at - last.from > 130) runs.push({ from: at, to: at });
      else last.to = at;
    }
    return runs;
  };
  const resolve = (c: Constraint) => {
    const master = [...c.positions.keys()].sort((a, b) => spines[b].priority - spines[a].priority)[0];
    const reference = { lat: c.references.reduce((n, p) => n + p.lat, 0) / c.references.length,
      lon: c.references.reduce((n, p) => n + p.lon, 0) / c.references.length };
    const masterPositions = c.positions.get(master)!;
    const projected = positionRuns(masterPositions).map((r) => centerProjection(master, reference, (r.from + r.to) / 2))
      .filter((p) => p !== undefined).sort((a, b) => a.distance - b.distance)[0]?.point ?? reference;
    const bridgeNodes = [...c.nodes];
    const pairedBridgeEnds = bridgeNodes.length === 2 ? bridgeNodes.map((node) =>
      (graph.adjacency.get(node) ?? []).map((id) => graph.edges[id]).filter((edge) =>
        edge.way.tags.bridge && edge.way.tags.bridge !== "no" && memberships[edge.id]?.length)) : [];
    const bridgePair = pairedBridgeEnds.length === 2
      && haversineMeters(nativeNodePositions.get(bridgeNodes[0])!, nativeNodePositions.get(bridgeNodes[1])!) <= 25
      && pairedBridgeEnds[0].some((a) => pairedBridgeEnds[1].some((b) =>
        a.way.tags.name && a.way.tags.name === b.way.tags.name && a.way.id !== b.way.id
        && /^(yes|1|-1)$/.test(a.way.tags.oneway ?? "") && /^(yes|1|-1)$/.test(b.way.tags.oneway ?? "")
        && Math.cos(trafficHeading(a) - trafficHeading(b)) < -.8));
    // A nearby loop of the same named road can be closer to the projection
    // search than the actual junction. Keep every contracted native node near
    // its mapped location, even when several junction constraints merge.
    const withinBound = (point: LatLon) => [...c.nodes].every((node) => haversineMeters(nativeNodePositions.get(node)!, point) <= 45);
    if (bridgePair && withinBound(reference)) c.point = reference;
    else if (withinBound(projected)) c.point = projected;
    else {
      let low = 0, high = 1;
      for (let i = 0; i < 20; i++) {
        const mid = (low + high) / 2;
        if (withinBound(interpolate(reference, projected, mid))) low = mid;
        else high = mid;
      }
      c.point = interpolate(reference, projected, low);
    }
    // Include the target chainage, so a contracted interval cannot run backwards
    // to reach a point outside it. The reference road stays on its own centre.
    for (const [id, positions] of c.positions) {
      for (const run of positionRuns(positions)) {
        const target = centerProjection(id, c.point, (run.from + run.to) / 2);
        if (target && target.distance < 55 && target.along >= run.from - 55 && target.along <= run.to + 55) positions.push(target.along);
      }
    }
  };
  constraints.forEach(resolve);
  const roots = constraints.map((_, i) => i);
  const root = (i: number): number => roots[i] === i ? i : roots[i] = root(roots[i]);
  let merged = true;
  while (merged) {
    merged = false;
    const intervals = new Map<number, { from: number; to: number; owner: number }[]>();
    constraints.forEach((c, owner) => {
      if (root(owner) !== owner) return;
      for (const [id, positions] of c.positions) {
        const list = intervals.get(id) ?? [];
        for (const run of positionRuns(positions)) list.push({ ...run, owner });
        intervals.set(id, list);
      }
    });
    for (const list of intervals.values()) {
      list.sort((a, b) => a.from - b.from);
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length && list[j].from <= list[i].to + .5; j++) {
        const a = root(list[i].owner), b = root(list[j].owner);
        if (a === b) continue;
        const first = constraints[a], second = constraints[b];
        if (haversineMeters(first.point, second.point) > 55) continue;
        roots[b] = a; merged = true;
        for (const node of second.nodes) first.nodes.add(node);
        first.references.push(...second.references);
        for (const [id, p] of second.positions) first.positions.set(id, [...first.positions.get(id) ?? [], ...p]);
        resolve(first);
      }
    }
  }
  constraints.forEach((c, i) => {
    if (root(i) !== i) return;
    if (diagnostics?.includeConstraints) (diagnostics.constraints ??= []).push({
      nodes: [...c.nodes], references: c.references, point: c.point,
      masterRoad: spines[[...c.positions.keys()].sort((a, b) => spines[b].priority - spines[a].priority)[0]].road,
    });
    for (const node of c.nodes) junctionNodes.set(node, c.point);
    for (const [id, positions] of c.positions) {
      for (const run of positionRuns(positions)) spines[id].anchors.push({ ...run, point: c.point });
    }
  });
  // Keep the native motorway/expressway junction fixed; a paired ramp may
  // approach its median, but must taper back to its real mainline attachment.
  for (const [node, native] of fastRoadNodes) {
    const positions = nodePositions.get(node);
    if (!positions?.length) continue;
    junctionNodes.set(node, native);
    for (const position of positions) spines[position.spine].anchors.push({
      from: position.along, to: position.along, point: native,
    });
  }
  // Continuous piecewise-linear displacement, not nearest-junction switching.
  // Close anchors interpolate between one another; remote ones taper to zero.
  for (const spine of spines) {
    const anchors = spine.anchors.sort((a, b) => a.from - b.from);
    if (stats) for (let i = 0; i < anchors.length; i++) for (let j = i + 1; j < anchors.length && anchors[j].from < anchors[i].to - .01; j++) {
      const meters = haversineMeters(anchors[i].point, anchors[j].point);
      if (meters > .1) {
        stats.anchorConflicts!++;
        const sources = [...assignments].filter(([, position]) => spines[position.spine] === spine
          && Math.max(position.from, position.to) >= anchors[i].from - 20
          && Math.min(position.from, position.to) <= anchors[j].to + 20).map(([id]) => graph.edges[id].id);
        (stats.anchorConflictExamples ??= []).push({ road: spine.road, sources,
          first: anchors[i], second: anchors[j], meters });
      }
    }
    for (let i = 0; i < anchors.length; i++) {
      const anchor = anchors[i], previous = anchors[i - 1], next = anchors[i + 1];
      if (!previous || anchor.from - previous.to > 80) spine.warp.push({ along: anchor.from - 40, lat: 0, lon: 0 });
      for (const along of [anchor.from, ...spine.distances.filter((at) => at > anchor.from && at < anchor.to), anchor.to]) {
        const base = pointAt(spine.center, spine.distances, along);
        spine.warp.push({ along, lat: anchor.point.lat - base.lat, lon: anchor.point.lon - base.lon });
      }
      if (!next || next.from - anchor.to > 80) spine.warp.push({ along: anchor.to + 40, lat: 0, lon: 0 });
    }
    spine.warp.sort((a, b) => a.along - b.along);
  }
  const spinePoint = (spine: Spine, along: number): LatLon => {
    if (spine.resolved) return pointAt(spine.resolved.points, spine.resolved.distances, along);
    const point = pointAt(spine.center, spine.distances, along);
    const warp = spine.warp;
    if (!warp.length || along < warp[0].along || along > warp.at(-1)!.along) return point;
    let low = 0, high = warp.length - 1;
    while (low + 1 < high) { const mid = (low + high) >> 1; if (warp[mid].along <= along) low = mid; else high = mid; }
    const t = warp[high].along > warp[low].along ? (along - warp[low].along) / (warp[high].along - warp[low].along) : 0;
    const delta = interpolate(warp[low], warp[high], t);
    return { lat: point.lat + delta.lat, lon: point.lon + delta.lon };
  };
  // Project the local deformation onto forward-progress constraints. Junction
  // anchors are fixed; only free blend vertices may move. This removes tiny
  // foldbacks automatically without changing a true native bend or U-turn.
  for (const spine of spines) {
    if (!spine.warp.length) continue;
    const total = spine.distances.at(-1)!;
    const distances = [...new Set([...spine.distances, ...spine.warp.map((w) => w.along).filter((at) => at >= 0 && at <= total)])].sort((a, b) => a - b);
    const original = distances.map((at) => spinePoint(spine, at));
    const points = original.map((p) => ({ ...p }));
    const fixed = distances.map((at) => at <= spine.warp[0].along || at >= spine.warp.at(-1)!.along
      || spine.anchors.some((a) => at >= a.from - .001 && at <= a.to + .001));
    const directions = distances.slice(1).map((at, i) => {
      const a = pointAt(spine.center, spine.distances, distances[i]), b = pointAt(spine.center, spine.distances, at);
      const x = (b.lon - a.lon) * metersLon, y = (b.lat - a.lat) * 110574, length = Math.hypot(x, y);
      return length > .01 ? { x: x / length, y: y / length } : { x: 0, y: 0 };
    });
    let changed = false;
    for (let iteration = 0; iteration < 200; iteration++) {
      let violation = 0;
      for (let i = 0; i < directions.length; i++) {
        const { x, y } = directions[i], a = points[i], b = points[i + 1];
        const progress = (b.lon - a.lon) * metersLon * x + (b.lat - a.lat) * 110574 * y;
        if (progress >= -.001 || (fixed[i] && fixed[i + 1])) continue;
        violation = Math.max(violation, -progress); changed = true;
        const count = Number(!fixed[i]) + Number(!fixed[i + 1]);
        const shift = -progress / count;
        if (!fixed[i]) { a.lon -= x * shift / metersLon; a.lat -= y * shift / 110574; }
        if (!fixed[i + 1]) { b.lon += x * shift / metersLon; b.lat += y * shift / 110574; }
      }
      if (violation < .001) break;
    }
    if (changed && points.every((p, i) => haversineMeters(p, original[i]) <= 10)) {
      spine.resolved = { distances, points };
      if (stats) stats.regularizedCorridors = (stats.regularizedCorridors ?? 0) + 1;
    }
  }
  const output: RoadNetworkChain[] = [];
  const collapsedRanges = new Set<string>();
  // Represent a native turning island by the two centreline arms through its
  // junction, instead of deleting its bus membership or drawing a third curve.
  const reroutedEdges = new Set<string>();
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  for (const junction of junctions) for (const turn of junction.turns) {
    if (turn.edgeIds.some((id) => reroutedEdges.has(id)) || !turn.edgeIds.some((id) => memberships[id]?.length)) continue;
    const center = junction.coreNodes.map((node) => junctionNodes.get(node)).find(Boolean);
    if (!center) continue;
    const arms = (node: number) => (nodePositions.get(node) ?? []).flatMap((p) => {
      const spine = spines[p.spine];
      if (!junction.names.includes(spine.group)) return [];
      const anchor = spine.anchors.find((a) => haversineMeters(a.point, center) < 1);
      if (!anchor) return [];
      const target = Math.max(anchor.from, Math.min(anchor.to, p.along));
      return [{ ...p, target, length: Math.abs(target - p.along) }];
    });
    // Station roads can keep the same name around a corner. Distinct arms,
    // not distinct street names, establish a two-leg route through the core.
    const choices = arms(turn.nodes[0]).flatMap((a) => arms(turn.nodes.at(-1)!).filter((b) => a.spine !== b.spine)
      .map((b) => ({ a, b, length: a.length + b.length })));
    choices.sort((a, b) => a.length - b.length);
    const choice = choices[0];
    const edges = turn.edgeIds.map((id) => edgeById.get(id)!);
    const nativeLength = edges.reduce((n, e) => n + e.length, 0);
    // A very short unnamed loop whose endpoints are both in the contracted
    // core has no separate through-arm. Its source membership remains in the
    // native graph while the display contracts this local traversal to a point.
    if (nativeLength <= 35 && turn.nodes.every((node) => junction.nodes.includes(node))
      && junction.coreNodes.includes(turn.nodes[0]) && junction.coreNodes.includes(turn.nodes.at(-1)!)
      && edges.every((edge) => !edge.way.tags.name && /^(residential|unclassified|service|busway)$/.test(edge.way.tags.highway)
        && haversineMeters(edge.a, center) <= 25 && haversineMeters(edge.b, center) <= 25)) {
      for (const edge of edges) {
        for (const range of matchedRanges?.[edge.id] ?? (memberships[edge.id] ?? []).map((key) => ({ key, from: 0, to: 1 })))
          collapsedRanges.add(`${edge.id}\0${range.key}`);
        reroutedEdges.add(edge.id);
      }
      if (stats) stats.contractedLocalTurns = (stats.contractedLocalTurns ?? 0) + 1;
      continue;
    }
    if (!choice || choice.length < nativeLength * .5 || choice.length > nativeLength * 2 || choice.length > 250) continue;
    const { a, b } = choice;
    const legs = [{ spine: a.spine, from: a.along, to: a.target, start: 0, length: a.length },
      { spine: b.spine, from: b.target, to: b.along, start: a.length, length: b.length }];
    const mapped: { spine: number; from: number; to: number; keys: string[]; source: string }[] = [];
    let cumulative = 0, safe = true;
    for (const edge of edges) {
      const ranges = matchedRanges?.[edge.id] ?? (memberships[edge.id] ?? []).map((key) => ({ from: 0, to: 1, key }));
      for (const range of ranges) {
        const lo = (cumulative + edge.length * range.from) / nativeLength * choice.length;
        const hi = (cumulative + edge.length * range.to) / nativeLength * choice.length;
        for (const leg of legs) {
          const from = Math.max(lo, leg.start), to = Math.min(hi, leg.start + leg.length);
          if (to - from < .05 || leg.length < .05) continue;
          const first = leg.from + (leg.to - leg.from) * (from - leg.start) / leg.length;
          const last = leg.from + (leg.to - leg.from) * (to - leg.start) / leg.length;
          for (let step = 0; step <= Math.ceil((to - from) / 5); step++) {
            const point = spinePoint(spines[leg.spine], first + (last - first) * step / Math.ceil((to - from) / 5));
            if (projectPointOnSegment(point, edge.a, edge.b).distanceMeters > 50) safe = false;
          }
          mapped.push({ spine: leg.spine, from: Math.min(first, last), to: Math.max(first, last), keys: [range.key], source: edge.id });
        }
      }
      cumulative += edge.length;
    }
    if (!safe || !mapped.length) continue;
    for (const range of mapped) spines[range.spine].ranges.push(range);
    turn.edgeIds.forEach((id) => reroutedEdges.add(id));
    if (stats) stats.reroutedTurns = (stats.reroutedTurns ?? 0) + 1;
  }
  const displayNode = (node: number, original: LatLon): LatLon => {
    if (fastRoadNodes.has(node)) return fastRoadNodes.get(node)!;
    if (junctionNodes.has(node)) return junctionNodes.get(node)!;
    const positions = nodePositions.get(node);
    if (!positions?.length) return original;
    const points = positions.map((p) => spinePoint(spines[p.spine], p.along));
    return { lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length, lon: points.reduce((sum, p) => sum + p.lon, 0) / points.length };
  };
  if (diagnostics?.includePositionShifts) for (const [node, positions] of nodePositions) {
    const edge = graph.edges[graph.adjacency.get(node)![0]];
    const native = edge.from === node ? edge.a : edge.b;
    const display = displayNode(node, native), meters = haversineMeters(native, display);
    if (meters > 15) (diagnostics.positionShifts ??= []).push({ node, native, display, meters,
      roads: [...new Set(positions.map((p) => spines[p.spine].road))] });
  }
  // A ramp remains a distinct road and grade. Spread its endpoint displacement
  // along the approach, rather than putting the whole offset into its last
  // 5-metre native edge and creating a hook across the carriageway.
  const rampWarps = new Map<number, { distances: number[]; knots: { along: number; lat: number; lon: number }[] }>();
  for (const way of graph.ways) {
    const gradedStreet = /^(primary|secondary|tertiary)$/.test(way.tags.highway)
      && way.tags.layer && way.tags.layer !== "0"
      && (!way.tags.bridge || way.tags.bridge === "no")
      && (!way.tags.tunnel || way.tags.tunnel === "no");
    if ((!/^(trunk_link|motorway_link|primary_link|secondary_link|tertiary_link|service|residential|unclassified)$/.test(way.tags.highway) && !gradedStreet)
      || !way.geometry.slice(1).some((_, i) => memberships[`${way.id}:${i}`]?.length)) continue;
    if (!way.tags.highway.endsWith("_link") && !/^(yes|1|-1)$/.test(way.tags.oneway ?? "")) continue;
    const distances = cumulativeLengths(way.geometry);
    const anchors = way.nodes.flatMap((node, i) => {
      if (i !== 0 && i !== way.nodes.length - 1 && !nodePositions.has(node) && !junctionNodes.has(node) && (graph.adjacency.get(node)?.length ?? 0) < 3) return [];
      const target = displayNode(node, way.geometry[i]);
      return [{ along: distances[i], lat: target.lat - way.geometry[i].lat, lon: target.lon - way.geometry[i].lon }];
    });
    if (!anchors.some((a) => Math.hypot(a.lat * 110574, a.lon * metersLon) > .1)) continue;
    const knots: typeof anchors = [];
    anchors.forEach((a, i) => {
      if (i > 0 && a.along - anchors[i - 1].along > 240) {
        knots.push({ along: anchors[i - 1].along + 120, lat: 0, lon: 0 }, { along: a.along - 120, lat: 0, lon: 0 });
      }
      knots.push(a);
    });
    rampWarps.set(way.id, { distances, knots });
    if (stats) {
      if (/^(motorway_link|trunk_link)$/.test(way.tags.highway)) stats.smoothedRampWays = (stats.smoothedRampWays ?? 0) + 1;
      else stats.smoothedLocalWays = (stats.smoothedLocalWays ?? 0) + 1;
    }
  }
  for (let id = 0; id < graph.edges.length; id++) {
    const edge = graph.edges[id], keys = memberships[edge.id];
    if (!keys?.length) continue;
    if (reroutedEdges.has(edge.id)) continue;
    const ranges = matchedRanges?.[edge.id] ?? keys.map((key) => ({ from: 0, to: 1, key }));
    const assignment = assignments.get(id);
    if (assignment) {
      for (const range of ranges) {
        const a = assignment.from + (assignment.to - assignment.from) * range.from;
        const b = assignment.from + (assignment.to - assignment.from) * range.to;
        spines[assignment.spine].ranges.push({ from: Math.min(a, b), to: Math.max(a, b), keys: [range.key], source: edge.id });
      }
      continue;
    }
    const from = nodePositions.get(edge.from), to = nodePositions.get(edge.to);
    const common = from?.find((p) => to?.some((q) => q.spine === p.spine));
    if (common) {
      const target = to!.find((p) => p.spine === common.spine)!;
      if (groupOf(edge, protectedEdges) === spines[common.spine].group
        && project(spines[common.spine], interpolate(edge.a, edge.b, .5))?.level === roadLevel(edge)
        && Math.abs(common.along - target.along) <= 80 && edge.length < 100) {
        if (Math.abs(common.along - target.along) > 1e-8) for (const range of ranges) {
          const a = common.along + (target.along - common.along) * range.from;
          const b = common.along + (target.along - common.along) * range.to;
          spines[common.spine].ranges.push({ from: Math.min(a, b), to: Math.max(a, b), keys: [range.key], source: edge.id });
        }
        else for (const range of ranges) collapsedRanges.add(`${edge.id}\0${range.key}`);
        continue;
      }
    }
    const a = displayNode(edge.from, edge.a), b = displayNode(edge.to, edge.b);
    const ramp = rampWarps.get(edge.way.id);
    const edgeIndex = Number(edge.id.split(":")[1]);
    const rampPoint = (t: number) => {
      if (!ramp) return interpolate(a, b, t);
      const native = interpolate(edge.a, edge.b, t), along = ramp.distances[edgeIndex] + edge.length * t;
      const delta = pointAt(ramp.knots, ramp.knots.map((k) => k.along), along);
      return { lat: native.lat + delta.lat, lon: native.lon + delta.lon };
    };
    const cuts = [...new Set(ranges.flatMap((r) => [r.from, r.to]))].sort((x, y) => x - y);
    for (let i = 1; i < cuts.length; i++) {
      const mid = (cuts[i - 1] + cuts[i]) / 2;
      const routeKeys = [...new Set(ranges.filter((r) => r.from <= mid && r.to >= mid).map((r) => r.key))].sort();
      const start = rampPoint(cuts[i - 1]), end = rampPoint(cuts[i]);
      const points = [start];
      if (ramp) {
        const steps = Math.ceil(edge.length * (cuts[i] - cuts[i - 1]) / 15);
        for (let j = 1; j < steps; j++) points.push(rampPoint(cuts[i - 1] + (cuts[i] - cuts[i - 1]) * j / steps));
      }
      points.push(end);
      if (routeKeys.length && haversineMeters(start, end) > .05) output.push({ points, routeKeys, covered: false, level: roadLevel(edge), road: edge.way.tags.name, sourceEdgeIds: [edge.id] });
      else for (const key of routeKeys) collapsedRanges.add(`${edge.id}\0${key}`);
    }
  }
  for (const spine of spines) {
    const shapeKnots = [...new Set([...spine.distances, ...spine.warp.map((w) => w.along)])].sort((a, b) => a - b);
    const events = new Map<number, { key: string; delta: number; source: string }[]>();
    for (const range of spine.ranges) {
      const from = range.from, to = range.to;
      if (to <= from) continue;
      for (const [at, delta] of [[from, 1], [to, -1]]) {
        const list = events.get(at) ?? [];
        for (const key of range.keys) list.push({ key, delta, source: range.source });
        events.set(at, list);
      }
    }
    // Keep level boundaries in the final chains for safe junction contraction.
    for (let i = 1; i < spine.levels.length; i++) if (spine.levels[i] !== spine.levels[i - 1]) {
      const at = spine.cumulative[i];
      if (!events.has(at)) events.set(at, []);
    }
    for (const anchor of spine.anchors) for (const at of [anchor.from, anchor.to]) if (!events.has(at)) events.set(at, []);
    const cuts = [...events.keys()].sort((a, b) => a - b);
    const active = new Map<string, number>();
    const sources = new Map<string, number>();
    const pairs = new Map<string, number>();
    for (let i = 0; i < cuts.length - 1; i++) {
      for (const event of events.get(cuts[i])!) {
        for (const [map, key] of [[active, event.key], [sources, event.source], [pairs, `${event.source}\0${event.key}`]] as const) {
          const n = (map.get(key) ?? 0) + event.delta; if (n > 0) map.set(key, n); else map.delete(key);
        }
      }
      if (!active.size) continue;
      const from = cuts[i], to = cuts[i + 1];
      const positions = [from, ...shapeKnots.filter((at) => at > from && at < to), to];
      const points = positions.map((at) => spinePoint(spine, at));
      if (stats) for (let j = 1; j < points.length; j++) {
        const a = pointAt(spine.center, spine.distances, positions[j - 1]), b = pointAt(spine.center, spine.distances, positions[j]);
        const dx = (b.lon - a.lon) * metersLon, dy = (b.lat - a.lat) * 110574;
        const length = Math.hypot(dx, dy);
        if (length < .05) continue;
        const progress = ((points[j].lon - points[j - 1].lon) * metersLon * dx + (points[j].lat - points[j - 1].lat) * 110574 * dy) / length;
        if (progress < -.75) {
          stats.corridorReversals = (stats.corridorReversals ?? 0) + 1;
          const examples = stats.reversalExamples ??= [];
          if (examples.length < 20) examples.push({ road: spine.road, meters: -progress, point: points[j] });
        }
      }
      if (points.every((p) => haversineMeters(p, points[0]) < .05)) {
        for (const pair of pairs.keys()) collapsedRanges.add(pair);
        continue;
      }
      const mid = (from + to) / 2;
      let segment = 0;
      while (segment + 1 < spine.levels.length && spine.cumulative[segment + 1] < mid) segment++;
      output.push({ points, routeKeys: [...active.keys()].sort(), covered: false, level: spine.levels[segment], road: spine.road, sourceEdgeIds: [...sources.keys()] });
    }
  }
  if (diagnostics) diagnostics.collapsedRanges = [...collapsedRanges];
  if (diagnostics?.includeSpines) diagnostics.spines = spines.map((s, i) => ({ road: s.road, reference: s.points,
    center: s.center, anchors: s.anchors, sources: [...assignments].filter(([, a]) => a.spine === i).map(([id]) => graph.edges[id].id) }));
  const rampIds = new Set(graph.edges.filter((edge) => /^(motorway_link|trunk_link)$/.test(edge.way.tags.highway)).map((edge) => edge.id));
  // The surface carriageway beside Guangming Overpass rejoins the bridge at
  // its east end. Share the last stretch of display centreline so it does not
  // draw a narrow, misleading triangle; native roads and grades stay intact.
  const bridgeDeck = output.filter((chain) => chain.sourceEdgeIds?.some((id) =>
    id.startsWith("212421302:") || id.startsWith("212421305:")));
  const bridgeEnd = bridgeDeck.flatMap((chain) => chain.points).sort((a, b) => b.lon - a.lon)[0];
  if (bridgeEnd) {
    const deckSegments = bridgeDeck.flatMap((chain) => chain.points.slice(1).map((b, i) => ({ a: chain.points[i], b })))
      .filter(({ a, b }) => Math.min(haversineMeters(a, bridgeEnd), haversineMeters(b, bridgeEnd)) <= 115);
    for (const chain of output) {
      if (chain.level !== "0|no|no" || roadFamily(chain.road ?? "") !== roadFamily("臺灣大道三段")
        || !chain.sourceEdgeIds?.some((id) => id.startsWith("289080999:") || id.startsWith("372351434:"))) continue;
      chain.points = chain.points.map((point) => {
        const fromEnd = haversineMeters(point, bridgeEnd);
        if (point.lat < bridgeEnd.lat || point.lon > bridgeEnd.lon || fromEnd >= 110) return point;
        let closest: LatLon | null = null, distance = Infinity;
        for (const segment of deckSegments) {
          const projection = projectPointOnSegment(point, segment.a, segment.b);
          if (projection.distanceMeters < distance) { closest = projection.closest; distance = projection.distanceMeters; }
        }
        if (!closest || distance > 18) return point;
        return interpolate(point, closest, Math.min(1, (110 - fromEnd) / 25));
      });
    }
  }
  for (const chain of output) {
    chain.fastRoad = chain.sourceEdgeIds?.some((id) => classification.mainline.has(id)) ?? false;
    chain.ramp = !chain.fastRoad && (chain.sourceEdgeIds?.some((id) => rampIds.has(id)) ?? false);
  }
  return output;
}
