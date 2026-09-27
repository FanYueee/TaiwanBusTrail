import type { RoadNetworkChain } from "./roadNetwork";

/** 共用座標與路線清單只儲存一次；整數座標精度約 0.1m。 */
export interface PackedNetwork {
  points: number[];
  routeKeys: string[];
  memberships: number[][];
  levels?: string[];
  fastRoadChains?: number[];
  rampChains?: number[];
  chains: [number, number[], number?][];
}

export function packNetwork(network: RoadNetworkChain[]): PackedNetwork {
  const points: number[] = [];
  const routeKeys: string[] = [];
  const routeIndex = new Map<string, number>();
  const memberships: number[][] = [];
  const pointIndex = new Map<string, number>();
  const memberIndex = new Map<string, number>();
  const levels: string[] = [];
  const chains: PackedNetwork["chains"] = network.map((chain) => {
    const memberKey = chain.routeKeys.join("|");
    let membership = memberIndex.get(memberKey);
    if (membership === undefined) {
      membership = memberships.length;
      memberships.push(chain.routeKeys.map((key) => {
        let id = routeIndex.get(key);
        if (id === undefined) { id = routeKeys.length; routeKeys.push(key); routeIndex.set(key, id); }
        return id;
      }));
      memberIndex.set(memberKey, membership);
    }
    const ids = chain.points.map((point) => {
      const lat = Math.round(point.lat * 1e6);
      const lon = Math.round(point.lon * 1e6);
      const key = `${lat},${lon}`;
      let id = pointIndex.get(key);
      if (id === undefined) {
        id = points.length / 2;
        points.push(lat, lon);
        pointIndex.set(key, id);
      }
      return id;
    });
    const level = chain.level ?? "0|no|no";
    let levelIndex = levels.indexOf(level);
    if (levelIndex < 0) { levelIndex = levels.length; levels.push(level); }
    return [membership, ids, levelIndex];
  });
  const fastRoadChains = network.flatMap((chain, index) => chain.fastRoad ? [index] : []);
  const rampChains = network.flatMap((chain, index) => chain.ramp ? [index] : []);
  return { points, routeKeys, memberships, levels, fastRoadChains, rampChains, chains };
}

export function unpackNetwork(data: PackedNetwork): RoadNetworkChain[] {
  const points = Array.from({ length: data.points.length / 2 }, (_, i) => ({ lat: data.points[i * 2] / 1e6, lon: data.points[i * 2 + 1] / 1e6 }));
  const memberships = data.memberships.map((ids) => ids.map((id) => data.routeKeys[id]));
  const fastRoadChains = new Set(data.fastRoadChains);
  const rampChains = new Set(data.rampChains);
  return data.chains.map(([membership, ids, level], index) => ({
    points: ids.map((id) => points[id]), routeKeys: memberships[membership], covered: false,
    level: level === undefined ? "0|no|no" : data.levels?.[level] ?? "0|no|no",
    fastRoad: fastRoadChains.has(index),
    ramp: rampChains.has(index),
  }));
}
