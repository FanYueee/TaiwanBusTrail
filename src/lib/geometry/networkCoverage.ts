import { buildExploredIndex } from "./explored";
import { createToleranceMatcher, type CoverageMatcher } from "./matcher";
import { computeCoverage } from "./coverage";
import type { RoadNetworkChain } from "./roadNetwork";
import type { RideRecord } from "../types";
import { shapeFingerprint } from "./shapeFingerprint";

/** Road membership is a hard gate. Geometric proximity at a junction is NOT
 * evidence that the neighbouring arm was ridden. Full rides use canonical road
 * identity; partial rides additionally require coverage within the saved slice.
 */
export function computeNetworkCoverage(network: RoadNetworkChain[], records: RideRecord[], tolerance: number, shapeHashes?: Record<string, string>): RoadNetworkChain[] {
  const byRoute = new Map<string, RideRecord[]>();
  const full = new Set<string>();
  for (const record of records) {
    const key = `${record.routeUID}:${record.direction}`;
    // A later reroute must not paint new roads from an older full-route record.
    if (record.fullRoute && (!shapeHashes || shapeHashes[key] === shapeFingerprint(record.geometry))) full.add(key);
    else { const list = byRoute.get(key) ?? []; list.push(record); byRoute.set(key, list); }
  }
  const matchers = new Map<string, CoverageMatcher>();
  return network.flatMap((chain) => {
    const members = chain.sourceRouteKeys ?? chain.routeKeys;
    if (members.some((key) => full.has(key))) return [{ ...chain, covered: true }];
    const partial = members.filter((key) => byRoute.has(key)).sort();
    if (!partial.length) return [{ ...chain, covered: false }];
    const key = partial.join("|");
    let matcher = matchers.get(key);
    if (!matcher) {
      matcher = createToleranceMatcher(buildExploredIndex(partial.flatMap((k) => byRoute.get(k)!)), {
        toleranceMeters: tolerance, endExtensionMeters: 0,
      });
      matchers.set(key, matcher);
    }
    return computeCoverage(chain.points, matcher).map((chunk) => ({ ...chain, ...chunk }));
  });
}
