import type { LatLon } from "../types";
import { haversineMeters, headingDifferenceRadians, interpolate, projectPointOnSegment, segmentHeadingRadians } from "./distance";
import { SegmentGridIndex } from "./spatialIndex";
import { simplifyPolyline } from "./simplify";

export interface ReferenceWay {
  id: number;
  nodes: number[];
  geometry: LatLon[];
  tags: Record<string, string>;
}
export interface ReferenceStation {
  id: number;
  lat: number;
  lon: number;
  name: string;
  kind: "bus_station" | "railway" | "public_transport";
}
export interface ReferenceEdge {
  id: string;
  from: number;
  to: number;
  a: LatLon;
  b: LatLon;
  length: number;
  way: ReferenceWay;
}
interface Candidate { edge: number; t: number; distance: number; emission: number }
export interface MatchedRange { edge: number; from: number; to: number }
export interface RoadRange { from: number; to: number; key: string }
export interface RoadMatchTrace {
  samples: LatLon[];
  transitions: { fromSample: number; toSample: number; candidateEdge: number; path: MatchedRange[] }[];
  gaps?: { sample: number; reason: "no-candidate" | "transition"; directMeters: number;
    shortestTransitionMeters: number | null; previousEdges: number[]; candidateEdges: number[];
    shortestPath?: MatchedRange[] }[];
}
interface State { candidate: Candidate; cost: number; parent: State | null; path: MatchedRange[]; sample: number }
interface Visit { distance: number; parent: number; edge: number }

class MinHeap {
  private items: [number, number][] = [];
  push(node: number, cost: number) {
    const item: [number, number] = [node, cost];
    let i = this.items.length;
    this.items.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent][1] <= cost) break;
      this.items[i] = this.items[parent]; i = parent;
    }
    this.items[i] = item;
  }
  pop(): [number, number] | undefined {
    const result = this.items[0];
    const last = this.items.pop();
    if (!last || !this.items.length) return result;
    let i = 0;
    while (i * 2 + 1 < this.items.length) {
      let child = i * 2 + 1;
      if (child + 1 < this.items.length && this.items[child + 1][1] < this.items[child][1]) child++;
      if (this.items[child][1] >= last[1]) break;
      this.items[i] = this.items[child]; i = child;
    }
    this.items[i] = last;
    return result;
  }
}

/** Fixed OSM graph. Crossings only connect at shared OSM node IDs. */
export class ReferenceRoadGraph {
  readonly edges: ReferenceEdge[] = [];
  readonly adjacency = new Map<number, number[]>();
  private index = new SegmentGridIndex(100);
  private trees = new Map<string, Map<number, Visit>>();

  constructor(readonly ways: ReferenceWay[], readonly stations: ReferenceStation[] = []) {
    for (const way of ways) {
      for (let i = 1; i < way.nodes.length; i++) {
        const a = way.geometry[i - 1], b = way.geometry[i];
        const length = haversineMeters(a, b);
        if (length < .1) continue;
        const id = this.edges.length;
        this.edges.push({ id: `${way.id}:${i - 1}`, from: way.nodes[i - 1], to: way.nodes[i], a, b, length, way });
        for (const node of [way.nodes[i - 1], way.nodes[i]]) {
          const bucket = this.adjacency.get(node) ?? [];
          bucket.push(id); this.adjacency.set(node, bucket);
        }
        this.index.add({ a, b, owner: String(id) });
      }
    }
  }

  private candidates(point: LatLon, heading: number, radius: number, limit: number): Candidate[] {
    const found: Candidate[] = [];
    const seen = new Set<number>();
    this.index.findNearby(point, radius, (segment) => {
      const id = Number(segment.owner);
      if (seen.has(id)) return false;
      seen.add(id);
      const projection = projectPointOnSegment(point, segment.a, segment.b);
      if (projection.distanceMeters > radius) return false;
      const angle = headingDifferenceRadians(heading, segment.headingRadians);
      const edge = this.edges[id];
      const minorPenalty = edge.way.tags.highway === "service" ? 2 : 0;
      found.push({ edge: id, t: projection.t, distance: projection.distanceMeters,
        emission: (projection.distanceMeters / 18) ** 2 + 3 * angle ** 2 + minorPenalty });
      return false;
    });
    // Dense vertices on one road must not evict a nearby connected alternative.
    // Keep local emission minima along each way, including separate hairpin arms.
    const byEdge = new Map(found.map((candidate) => [candidate.edge, candidate]));
    return found.filter((candidate) => {
      const edge = this.edges[candidate.edge];
      return ![edge.from, edge.to].some((node) => (this.adjacency.get(node) ?? []).some((id) => {
        const other = byEdge.get(id);
        if (!other || id === candidate.edge || this.edges[id].way.id !== edge.way.id) return false;
        const neighbour = this.edges[id];
        const along = (edge.from === node ? candidate.t : 1 - candidate.t) * edge.length
          + (neighbour.from === node ? other.t : 1 - other.t) * neighbour.length;
        return along <= 30 && (other.emission < candidate.emission
          || (other.emission === candidate.emission && id < candidate.edge));
      }));
    }).sort((a, b) => a.emission - b.emission).slice(0, limit);
  }

  private tree(start: number, limit: number): Map<number, Visit> {
    const radius = limit <= 650 ? 650 : Math.ceil(limit / 250) * 250;
    const key = `${start}:${radius}`;
    const cached = this.trees.get(key);
    if (cached) return cached;
    const visits = new Map<number, Visit>([[start, { distance: 0, parent: start, edge: -1 }]]);
    const heap = new MinHeap(); heap.push(start, 0);
    for (;;) {
      const item = heap.pop();
      if (!item) break;
      const [node, distance] = item;
      if (distance !== visits.get(node)?.distance) continue;
      for (const id of this.adjacency.get(node) ?? []) {
        const edge = this.edges[id];
        const other = edge.from === node ? edge.to : edge.from;
        const next = distance + edge.length;
        if (next > radius || next >= (visits.get(other)?.distance ?? Infinity)) continue;
        visits.set(other, { distance: next, parent: node, edge: id });
        heap.push(other, next);
      }
    }
    if (this.trees.size > 3000) this.trees.delete(this.trees.keys().next().value!);
    this.trees.set(key, visits);
    return visits;
  }

  private transition(a: Candidate, b: Candidate, limit: number): { length: number; path: MatchedRange[] } | null {
    if (a.edge === b.edge) return { length: Math.abs(a.t - b.t) * this.edges[a.edge].length, path: [{ edge: a.edge, from: a.t, to: b.t }] };
    const from = this.edges[a.edge], to = this.edges[b.edge];
    let best: { length: number; path: MatchedRange[] } | null = null;
    for (const [start, lead] of [[from.from, a.t * from.length], [from.to, (1 - a.t) * from.length]]) {
      const tree = this.tree(start, limit);
      for (const [end, tail] of [[to.from, b.t * to.length], [to.to, (1 - b.t) * to.length]]) {
        const visit = tree.get(end);
        if (!visit) continue;
        const length = lead + visit.distance + tail;
        if (best && length >= best.length) continue;
        const path: MatchedRange[] = [];
        let node = end;
        while (node !== start) {
          const entry = tree.get(node)!;
          const edge = this.edges[entry.edge];
          path.push({ edge: entry.edge, from: edge.from === entry.parent ? 0 : 1, to: edge.to === node ? 1 : 0 });
          node = entry.parent;
        }
        best = { length, path: [
          { edge: a.edge, from: a.t, to: start === from.from ? 0 : 1 },
          ...path.reverse(),
          { edge: b.edge, from: end === to.from ? 0 : 1, to: b.t },
        ] };
      }
    }
    return best;
  }

  /** Viterbi sequence matching: proximity + heading + connected network travel distance.
   * Undirected geometry matching deliberately permits bus contraflow; this is not a navigation router.
   * Unmatched spans are reported, never joined with invented straight lines.
   */
  match(points: LatLon[], trace?: RoadMatchTrace) {
    const primaryTrace: RoadMatchTrace = trace ?? { samples: [], transitions: [] };
    const result = this.matchWithin(points, primaryTrace, 100);
    if (!result.unmatched) return { ...result, searchRadius: 100 };
    const retryTrace: RoadMatchTrace = { samples: [], transitions: [] };
    const anchors = new Map<number, number>();
    for (const sample of new Set([0, primaryTrace.samples.length - 1,
      ...primaryTrace.gaps!.filter((gap) => gap.reason === "transition").map((gap) => gap.sample)])) {
      const point = primaryTrace.samples[sample];
      const heading = segmentHeadingRadians(primaryTrace.samples[Math.max(0, sample - 1)],
        primaryTrace.samples[Math.min(primaryTrace.samples.length - 1, sample + 1)]);
      const nearest = Math.min(...this.candidates(point, heading, 100, 64).map((candidate) => candidate.distance));
      const endpoint = sample === 0 || sample === primaryTrace.samples.length - 1;
      if (Number.isFinite(nearest) && (endpoint || nearest <= 10)) anchors.set(sample, Math.min(100, nearest + 20));
    }
    const retry = this.matchWithin(points, retryTrace, 200, anchors);
    // Keep visits to the roads at endpoints and breaks. A retry may remove
    // gaps, but cannot replace them with breaks at other observations.
    const originalGaps = new Set(primaryTrace.gaps!.map((gap) => `${gap.sample}:${gap.reason}`));
    if (retry.unmatched >= result.unmatched
      || retryTrace.gaps!.some((gap) => !originalGaps.has(`${gap.sample}:${gap.reason}`))) return { ...result, searchRadius: 100 };
    if (trace) Object.assign(trace, retryTrace);
    return { ...retry, searchRadius: 200 };
  }

  private matchWithin(points: LatLon[], trace: RoadMatchTrace | undefined, candidateRadius: number, anchors?: Map<number, number>): { edges: number[]; ranges: MatchedRange[]; unmatched: number; samples: number; maxOffset: number; junctionExcursions: number } {
    const shape = simplifyPolyline(points, 3);
    const samples: LatLon[] = shape.length ? [shape[0]] : [];
    for (let i = 1; i < shape.length; i++) {
      const length = haversineMeters(shape[i - 1], shape[i]);
      // Sparse shape vertices may skip a curved ramp. Dense chord samples
      // would treat invented straight-line positions as observations.
      const steps = Math.max(1, Math.ceil(length / 500));
      for (let j = 1; j <= steps; j++) samples.push(interpolate(shape[i - 1], shape[i], j / steps));
    }
    if (trace) { trace.samples = samples; trace.transitions = []; trace.gaps = []; }
    const matched = new Set<number>();
    const intervals = new Map<number, { from: number; to: number }[]>();
    let states: State[] = [];
    let previous: LatLon | null = null;
    let unmatched = 0, maxOffset = 0, junctionExcursions = 0;
    const finish = () => {
      let state: State | null = states.sort((a, b) => a.cost - b.cost)[0] ?? null;
      const sequence: State[] = [];
      while (state) {
        maxOffset = Math.max(maxOffset, state.candidate.distance);
        sequence.push(state); state = state.parent;
      }
      sequence.reverse();
      const paths = sequence.map((s) => s.path.filter((r) => Math.abs(r.to - r.from) * this.edges[r.edge].length >= .05));
      // A noisy corner sample may project a few metres onto a THIRD road,
      // then return to the very same native junction. It makes no route progress.
      // Remove only this paired interior excursion, not short roads in general.
      // Real route endpoints and source-shape U-turns are explicitly preserved.
      for (let i = 1; i + 1 < sequence.length; i++) {
        const incoming = paths[i].at(-1), outgoing = paths[i + 1][0];
        if (!incoming || !outgoing || incoming.edge !== outgoing.edge || incoming.edge !== sequence[i].candidate.edge) continue;
        if (Math.abs(incoming.to - outgoing.from) > 1e-8 || Math.abs(incoming.from - outgoing.to) > 1e-8
          || (incoming.from !== 0 && incoming.from !== 1) || incoming.from === incoming.to) continue;
        const before = samples[sequence[i - 1].sample], at = samples[sequence[i].sample], after = samples[sequence[i + 1].sample];
        const turn = Math.cos(segmentHeadingRadians(before, at) - segmentHeadingRadians(at, after));
        if (turn <= -.5) continue;
        // A rounded U-turn can distribute its reversal across several samples.
        // Check a short source neighbourhood as well as the immediate vertex.
        let left = sequence[i].sample, right = left, travelled = 0;
        while (left > sequence[0].sample && travelled < 15) { travelled += haversineMeters(samples[left], samples[left - 1]); left--; }
        travelled = 0;
        while (right < sequence.at(-1)!.sample && travelled < 15) { travelled += haversineMeters(samples[right], samples[right + 1]); right++; }
        if (Math.cos(segmentHeadingRadians(samples[left], at) - segmentHeadingRadians(at, samples[right])) <= -.5) continue;
        let count = 0, depth = 0;
        while (count < paths[i].length && count < paths[i + 1].length) {
          const enter = paths[i][paths[i].length - 1 - count], leave = paths[i + 1][count];
          if (enter.edge !== leave.edge || Math.abs(enter.to - leave.from) > 1e-8 || Math.abs(enter.from - leave.to) > 1e-8
            || (enter.from !== 0 && enter.from !== 1)) break;
          depth += Math.abs(enter.to - enter.from) * this.edges[enter.edge].length;
          count++;
        }
        if (depth > 12) continue;
        paths[i].splice(paths[i].length - count, count); paths[i + 1].splice(0, count); junctionExcursions++;
      }
      if (trace) for (let i = 1; i < sequence.length; i++) trace.transitions.push({
        fromSample: sequence[i - 1].sample,
        toSample: sequence[i].sample,
        candidateEdge: sequence[i].candidate.edge,
        path: paths[i],
      });
      for (const path of paths) {
        for (const range of path) {
          const from = Math.min(range.from, range.to), to = Math.max(range.from, range.to);
          if ((to - from) * this.edges[range.edge].length < .05) continue;
          matched.add(range.edge);
          const list = intervals.get(range.edge) ?? [];
          list.push({ from, to }); intervals.set(range.edge, list);
        }
      }
    };
    for (let i = 0; i < samples.length; i++) {
      const point = samples[i];
      const before = samples[Math.max(0, i - 1)], after = samples[Math.min(samples.length - 1, i + 1)];
      const incomingHeading = segmentHeadingRadians(before, point), outgoingHeading = segmentHeadingRadians(point, after);
      // The chord across a real U-turn can have zero length (or point at an
      // unrelated street). Use the approach direction at a cusp instead.
      const heading = i > 0 && i + 1 < samples.length && Math.cos(incomingHeading - outgoingHeading) < -.5
        ? incomingHeading : segmentHeadingRadians(before, after);
      const candidates = this.candidates(point, heading, anchors?.get(i) ?? candidateRadius, candidateRadius > 100 ? 64 : 16);
      if (!candidates.length) {
        trace?.gaps?.push({ sample: i, reason: "no-candidate", directMeters: previous ? haversineMeters(previous, point) : 0,
          shortestTransitionMeters: null, previousEdges: states.map((state) => state.candidate.edge), candidateEdges: [] });
        finish(); states = []; previous = null; unmatched++; continue;
      }
      const direct = previous ? haversineMeters(previous, point) : 0;
      const transitionLimit = Math.max(200, direct * 3 + 50);
      // Score the native path between sparse observations as well as its ends;
      // otherwise a shorter parallel flyover can replace a surface route.
      const pathCosts = new Map<number, number>();
      const pathCost = (path: MatchedRange[]) => {
        if (!previous || direct <= 65) return 0;
        return path.reduce((sum, range) => {
          const edge = this.edges[range.edge], length = Math.abs(range.to - range.from) * edge.length;
          if (length < .05) return sum;
          const full = Math.abs(range.to - range.from) > 1 - 1e-8;
          let cost = full ? pathCosts.get(range.edge) : undefined;
          if (cost === undefined) {
            const middle = interpolate(edge.a, edge.b, (range.from + range.to) / 2);
            const offset = projectPointOnSegment(middle, previous!, point).distanceMeters;
            cost = length / 65 * (offset / 18) ** 2;
            if (full) pathCosts.set(range.edge, cost);
          }
          return sum + cost;
        }, 0);
      };
      const next: State[] = [];
      let shortestTransition = Infinity;
      let shortestPath: MatchedRange[] | undefined;
      for (const candidate of candidates) {
        if (!states.length) { next.push({ candidate, cost: candidate.emission, parent: null, path: [], sample: i }); continue; }
        let best: State | null = null;
        for (const state of states) {
          const transition = this.transition(state.candidate, candidate, transitionLimit);
          if (transition && transition.length < shortestTransition) {
            shortestTransition = transition.length; shortestPath = transition.path;
          }
          if (!transition || transition.length > transitionLimit) continue;
          const cost = state.cost + candidate.emission + Math.abs(transition.length - direct) / 12 + pathCost(transition.path);
          if (!best || cost < best.cost) best = { candidate, cost, parent: state, path: transition.path, sample: i };
        }
        if (best) next.push(best);
      }
      if (!next.length) {
        trace?.gaps?.push({ sample: i, reason: "transition", directMeters: direct,
          shortestTransitionMeters: Number.isFinite(shortestTransition) ? shortestTransition : null,
          previousEdges: states.map((state) => state.candidate.edge), candidateEdges: candidates.map((candidate) => candidate.edge), shortestPath });
        finish(); unmatched++; states = candidates.map((candidate) => ({ candidate, cost: candidate.emission, parent: null, path: [], sample: i }));
      }
      else states = next.sort((a, b) => a.cost - b.cost);
      previous = point;
    }
    finish();
    const ranges: MatchedRange[] = [];
    for (const [edge, list] of intervals) {
      list.sort((a, b) => a.from - b.from);
      for (const range of list) {
        const previous = ranges[ranges.length - 1];
        if (previous?.edge === edge && range.from <= previous.to + 1e-9) previous.to = Math.max(previous.to, range.to);
        else ranges.push({ edge, ...range });
      }
    }
    return { edges: [...matched], ranges, unmatched, samples: samples.length, maxOffset, junctionExcursions };
  }
}
