import type { LatLon } from "@/lib/types";

import {
  haversineMeters,
  headingDifferenceRadians,
  interpolate,
  projectPointOnSegment,
  segmentHeadingRadians,
} from "./distance";
import type { CoverageChunk } from "./coverage";
import { SegmentGridIndex } from "./spatialIndex";

/**
 * 路網合併（Road network）
 *
 * 全部路線模式不再「逐路線畫線」，而是把所有路線的幾何合併成一張路網：
 *   1. 距離很近的頂點合併成同一個節點（節點位置取平均，仍貼在實際幾何上）
 *   2. 相鄰節點形成邊（edge）；同一條邊若有多條路線經過，只保留一條
 *   3. 邊的顏色 = 任一條經過的路線已走過即為綠色（已走過優先）
 *   4. 沿著路網把邊串成長鏈後繪製
 *
 * 因為所有邊都是同一張圖的一部分、相鄰邊共用節點，
 * 畫面上一條路只會有一條線、且不會有單一區塊消失造成的空格。
 * popup 則列出每條鏈的來源路線。
 */

const REF_LAT = 24.15;
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos((REF_LAT * Math.PI) / 180);

const NODE_GRID_METERS = 50;

export interface RoadNetworkInput {
  key: string;
  chunks: CoverageChunk[];
}

export interface RoadNetworkChain {
  points: LatLon[];
  covered: boolean;
  routeKeys: string[];
}

export interface RoadNetworkOptions {
  /**
   * 重新取樣間距（公尺）：不同路線的頂點間距與相位都不同，
   * 先統一重取樣，節點才對得上、同一條路才能真正合併。預設 30
   */
  resampleSpacingMeters?: number;
  /**
   * 頂點合併半徑（公尺）：此距離內視為同一個路網節點，預設 6。
   * 必須明顯小於雙向車道間距，否則對向車道會被黏成同一個節點，
   * 畫面上會出現跨車道的鋸齒／交叉線。
   */
  mergeRadiusMeters?: number;
  /** 每條鏈最多保留的來源路線數（popup 用），預設 12 */
  maxRouteKeys?: number;
  /** 路口直行容許角度（度）：超過就視為轉向而中斷鏈，預設 65 */
  continueHeadingToleranceDeg?: number;
  /**
   * 端點貼合半徑（公尺）：鏈的頭尾若距離其他鏈在此距離內，
   * 會延伸接上最近的點，消除路口／轉彎處的小空隙。預設 30，0 表示關閉
   */
  endpointSnapMeters?: number;
}

interface Node {
  lat: number;
  lon: number;
  count: number;
}

interface Edge {
  a: number;
  b: number;
  covered: boolean;
  keys: string[];
}

function totalPointCount(input: RoadNetworkInput): number {
  let count = 0;
  for (const chunk of input.chunks) count += chunk.points.length;
  return count;
}

/** 依固定間距重新取樣，保留原始頂點以維持轉角精度 */
function resample(points: LatLon[], spacingMeters: number): LatLon[] {
  if (points.length < 2) return points.slice();
  const result: LatLon[] = [points[0]];
  let carry = 0;

  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    const length = haversineMeters(from, to);
    if (length <= 0) continue;

    let remaining = spacingMeters - carry;
    while (remaining <= length) {
      const t = remaining / length;
      result.push(interpolate(from, to, t));
      remaining += spacingMeters;
    }
    // 保留原始頂點（轉角）
    const last = result[result.length - 1];
    if (haversineMeters(last, to) > 1) result.push(to);
    carry = (carry + length) % spacingMeters;
  }

  return result;
}

function cellKey(lat: number, lon: number, sizeMeters: number): string {
  const cx = Math.floor((lon * M_PER_DEG_LON) / sizeMeters);
  const cy = Math.floor((lat * M_PER_DEG_LAT) / sizeMeters);
  return `${cx},${cy}`;
}

export function buildRoadNetwork(
  inputs: RoadNetworkInput[],
  options: RoadNetworkOptions = {},
): RoadNetworkChain[] {
  const resampleSpacing = Math.max(5, options.resampleSpacingMeters ?? 30);
  // 合併半徑需小於取樣間距，否則同一條路線的相鄰取樣點會自己合併掉
  const mergeRadius = Math.min(
    Math.max(2, options.mergeRadiusMeters ?? 6),
    resampleSpacing * 0.6,
  );
  const maxRouteKeys = Math.max(1, options.maxRouteKeys ?? 12);
  const continueTolerance =
    ((options.continueHeadingToleranceDeg ?? 65) * Math.PI) / 180;

  const nodes: Node[] = [];
  const nodeBuckets = new Map<string, number[]>();

  const resolveNode = (point: LatLon): number => {
    const cell = cellKey(point.lat, point.lon, NODE_GRID_METERS);
    const [cxText, cyText] = cell.split(",");
    const cx = Number(cxText);
    const cy = Number(cyText);

    let bestId = -1;
    let bestDistance = mergeRadius;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = nodeBuckets.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const id of bucket) {
          const distance = haversineMeters(point, { lat: nodes[id].lat, lon: nodes[id].lon });
          if (distance < bestDistance) {
            bestDistance = distance;
            bestId = id;
          }
        }
      }
    }

    if (bestId >= 0) {
      const node = nodes[bestId];
      node.count += 1;
      node.lat += (point.lat - node.lat) / node.count;
      node.lon += (point.lon - node.lon) / node.count;
      return bestId;
    }

    const id = nodes.length;
    nodes.push({ lat: point.lat, lon: point.lon, count: 1 });
    const bucket = nodeBuckets.get(cell);
    if (bucket) bucket.push(id);
    else nodeBuckets.set(cell, [id]);
    return id;
  };

  const edges: Edge[] = [];
  const edgeIndex = new Map<string, number>();
  const adjacency = new Map<number, number[]>();

  const addEdge = (a: number, b: number, covered: boolean, routeKey: string) => {
    if (a === b) return;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const existing = edgeIndex.get(key);
    if (existing !== undefined) {
      const edge = edges[existing];
      edge.covered = edge.covered || covered;
      if (edge.keys.length < maxRouteKeys && !edge.keys.includes(routeKey)) {
        edge.keys.push(routeKey);
      }
      return;
    }

    const id = edges.length;
    edges.push({ a, b, covered, keys: [routeKey] });
    edgeIndex.set(key, id);
    for (const node of [a, b]) {
      const list = adjacency.get(node);
      if (list) list.push(id);
      else adjacency.set(node, [id]);
    }
  };

  const sorted = [...inputs].sort(
    (a, b) => totalPointCount(b) - totalPointCount(a) || a.key.localeCompare(b.key),
  );

  for (const input of sorted) {
    for (const chunk of input.chunks) {
      if (chunk.points.length < 2) continue;
      const points = resample(chunk.points, resampleSpacing);
      let previousNode = resolveNode(points[0]);
      for (let i = 1; i < points.length; i++) {
        const node = resolveNode(points[i]);
        addEdge(previousNode, node, chunk.covered, input.key);
        previousNode = node;
      }
    }
  }

  const nodePosition = (id: number): LatLon => ({ lat: nodes[id].lat, lon: nodes[id].lon });
  const otherNode = (edgeId: number, node: number): number =>
    edges[edgeId].a === node ? edges[edgeId].b : edges[edgeId].a;

  const visited = new Uint8Array(edges.length);
  const rawChains: (RoadNetworkChain & { startNode: number; endNode: number })[] = [];

  const walk = (startEdgeId: number, startNode?: number) => {
    const startEdge = edges[startEdgeId];
    let from = startNode ?? startEdge.a;
    let to = otherNode(startEdgeId, from);

    visited[startEdgeId] = 1;
    const points: LatLon[] = [nodePosition(from), nodePosition(to)];
    const routeKeys = [...startEdge.keys];
    const covered = startEdge.covered;

    let currentNode = to;
    let incomingHeading = segmentHeadingRadians(points[0], points[1]);

    for (;;) {
      let nextEdgeId = -1;
      let bestDiff = continueTolerance;
      for (const candidateId of adjacency.get(currentNode) ?? []) {
        if (visited[candidateId]) continue;
        const candidate = edges[candidateId];
        if (candidate.covered !== covered) continue; // 顏色不同就分段
        const target = otherNode(candidateId, currentNode);
        const heading = segmentHeadingRadians(nodePosition(currentNode), nodePosition(target));
        const diff = headingDifferenceRadians(incomingHeading, heading);
        if (diff < bestDiff) {
          bestDiff = diff;
          nextEdgeId = candidateId;
        }
      }
      if (nextEdgeId < 0) break;

      visited[nextEdgeId] = 1;
      const nextNode = otherNode(nextEdgeId, currentNode);
      points.push(nodePosition(nextNode));
      for (const key of edges[nextEdgeId].keys) {
        if (routeKeys.length < maxRouteKeys && !routeKeys.includes(key)) {
          routeKeys.push(key);
        }
      }
      incomingHeading = segmentHeadingRadians(
        nodePosition(currentNode),
        nodePosition(nextNode),
      );
      currentNode = nextNode;
    }

    rawChains.push({ points, covered, routeKeys, startNode: from, endNode: currentNode });
  };

  // 先從路網端點開始走，再處理剩下的（環狀或角度不合而中斷的邊）
  for (let id = 0; id < edges.length; id++) {
    if (visited[id]) continue;
    const edge = edges[id];
    const degreeA = (adjacency.get(edge.a) ?? []).length;
    const degreeB = (adjacency.get(edge.b) ?? []).length;
    if (degreeA === 1 || degreeB === 1) {
      walk(id, degreeA === 1 ? edge.a : edge.b);
    }
  }
  for (let id = 0; id < edges.length; id++) {
    if (!visited[id]) walk(id);
  }

  // 合併端點相連、顏色相同的鏈，降低圖層數量
  const chainsByNode = new Map<number, number[]>();
  rawChains.forEach((chain, index) => {
    for (const node of [chain.startNode, chain.endNode]) {
      const list = chainsByNode.get(node);
      if (list) list.push(index);
      else chainsByNode.set(node, [index]);
    }
  });

  const used = new Uint8Array(rawChains.length);
  const merged: RoadNetworkChain[] = [];

  for (let index = 0; index < rawChains.length; index++) {
    if (used[index]) continue;
    used[index] = 1;

    const base = rawChains[index];
    const points = [...base.points];
    const routeKeys = [...base.routeKeys];
    let endNode = base.endNode;

    for (;;) {
      let mergedAny = false;
      for (const candidateIndex of chainsByNode.get(endNode) ?? []) {
        if (used[candidateIndex]) continue;
        const candidate = rawChains[candidateIndex];
        if (candidate.covered !== base.covered) continue;

        const connectsAtStart = candidate.startNode === endNode;
        const connectsAtEnd = candidate.endNode === endNode;
        if (!connectsAtStart && !connectsAtEnd) continue;

        const candidatePoints = connectsAtStart
          ? candidate.points
          : [...candidate.points].reverse();
        points.push(...candidatePoints.slice(1));
        endNode = connectsAtStart ? candidate.endNode : candidate.startNode;

        for (const key of candidate.routeKeys) {
          if (routeKeys.length < maxRouteKeys && !routeKeys.includes(key)) {
            routeKeys.push(key);
          }
        }

        used[candidateIndex] = 1;
        mergedAny = true;
        break;
      }
      if (!mergedAny) break;
    }

    merged.push({ points, covered: base.covered, routeKeys });
  }

  snapChainEndpoints(merged, options.endpointSnapMeters);

  return merged.filter((chain) => chain.points.length >= 2);
}

/**
 * 把每條鏈的頭尾延伸接上附近的其他鏈。
 *
 * 去重與鏈走訪會在路口／轉彎處留下 1～30m 的短空隙：線段在距離另一條線
 * 很近的地方結束，但沒有實際相連。這裡把端點投影到最近的鏈上並補進端點，
 * 讓畫面上的線真正連起來。
 */
function snapChainEndpoints(
  chains: RoadNetworkChain[],
  snapRadiusOption: number | undefined,
): void {
  const snapRadius = Math.max(0, snapRadiusOption ?? 30);
  if (snapRadius <= 0 || chains.length < 2) return;

  const segmentIndex = new SegmentGridIndex(50);
  chains.forEach((chain, chainIndex) => {
    for (let i = 1; i < chain.points.length; i++) {
      segmentIndex.add({
        a: chain.points[i - 1],
        b: chain.points[i],
        owner: String(chainIndex),
      });
    }
  });

  const nearestOnOtherChain = (chainIndex: number, point: LatLon): LatLon | null => {
    let best: LatLon | null = null;
    let bestDistance = snapRadius;
    segmentIndex.findNearby(point, snapRadius, (segment) => {
      if (segment.owner === String(chainIndex)) return false;
      const projection = projectPointOnSegment(point, segment.a, segment.b);
      if (projection.distanceMeters < bestDistance) {
        bestDistance = projection.distanceMeters;
        best = projection.closest;
      }
      return false;
    });
    return best;
  };

  for (let chainIndex = 0; chainIndex < chains.length; chainIndex++) {
    const chain = chains[chainIndex];
    const start = chain.points[0];
    const startSnap = nearestOnOtherChain(chainIndex, start);
    if (startSnap && haversineMeters(startSnap, start) > 0.5) {
      chain.points.unshift(startSnap);
    }
    const end = chain.points[chain.points.length - 1];
    const endSnap = nearestOnOtherChain(chainIndex, end);
    if (endSnap && haversineMeters(endSnap, end) > 0.5) {
      chain.points.push(endSnap);
    }
  }
}
