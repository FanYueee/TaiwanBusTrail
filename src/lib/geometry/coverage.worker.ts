import { computeNetworkCoverage } from "./networkCoverage";
import type { RoadNetworkChain } from "./roadNetwork";
import type { RideRecord } from "../types";

self.onmessage = (event: MessageEvent<{ network: RoadNetworkChain[]; records: RideRecord[]; tolerance: number; shapeHashes: Record<string, string> }>) => {
  try {
    const { network, records, tolerance, shapeHashes } = event.data;
    if (records.length === 0) { self.postMessage({ network }); return; }
    const result = computeNetworkCoverage(network, records, tolerance, shapeHashes);
    self.postMessage({ network: result });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
