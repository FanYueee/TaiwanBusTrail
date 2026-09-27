import { readFile, writeFile, rename } from "node:fs/promises";
import { ReferenceRoadGraph, type ReferenceWay, type ReferenceStation, type RoadRange } from "../src/lib/geometry/referenceRoads";
import { applyReviewedRoadCorrections, type ReviewedRoadCorrection } from "../src/lib/geometry/matchCorrections";
import type { LatLon, BusRoute } from "../src/lib/types";
import { tdxDataFile } from "../src/lib/tdx/dataDir";

async function main() {
  const roads = JSON.parse(await readFile(tdxDataFile("roads.json"), "utf8")) as { ways: ReferenceWay[]; stations?: ReferenceStation[] };
  const shapes = JSON.parse(await readFile(tdxDataFile("shapes.json"), "utf8")) as Record<string, { geometry: LatLon[] | null }>;
  const routes = JSON.parse(await readFile(tdxDataFile("routes.json"), "utf8")) as BusRoute[];
  const meta = JSON.parse(await readFile(tdxDataFile("meta.json"), "utf8"));
  const graph = new ReferenceRoadGraph(roads.ways, roads.stations);
  console.log(`Reference graph: ${graph.edges.length} edges`);
  const memberships: Record<string, string[]> = {};
  const ranges: Record<string, RoadRange[]> = {};
  const reports: Record<string, { unmatched: number; samples: number; maxOffset: number; edges: number; junctionExcursions: number; searchRadius: number }> = {};
  const routeFilter = process.env.TCBUS_MATCH_ROUTES?.split(",");
  const selected = routes.filter((route) => !routeFilter || routeFilter.includes(route.routeUID));
  const start = performance.now();
  for (let i = 0; i < selected.length; i++) {
    const route = selected[i];
    const key = `${route.routeUID}:${route.direction}`;
    const points = shapes[key]?.geometry;
    if (!points) continue;
    const result = graph.match(points);
    reports[key] = { unmatched: result.unmatched, samples: result.samples, maxOffset: result.maxOffset, edges: result.edges.length, junctionExcursions: result.junctionExcursions, searchRadius: result.searchRadius };
    for (const id of result.edges) (memberships[graph.edges[id].id] ??= []).push(key);
    for (const range of result.ranges) (ranges[graph.edges[range.edge].id] ??= []).push({ from: range.from, to: range.to, key });
    if ((i + 1) % 10 === 0 || i === selected.length - 1) console.log(`${i + 1}/${selected.length} matched (${((performance.now() - start) / 1000).toFixed(1)}s)`);
  }
  if (typeof meta.city === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/.test(meta.city)) {
    let corrections: ReviewedRoadCorrection[] = [];
    try {
      const data = JSON.parse(await readFile(`config/road-corrections/${meta.city}.json`, "utf8"));
      if (!Array.isArray(data.corrections)) throw new Error(`Invalid road corrections for ${meta.city}`);
      corrections = data.corrections;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    applyReviewedRoadCorrections(graph, corrections, shapes, memberships, ranges, new Set(Object.keys(reports)));
  }
  const target = tdxDataFile(routeFilter ? "road-matches-preview.json" : "road-matches.json");
  await writeFile(`${target}.tmp`, JSON.stringify({ version: 2, algorithmVersion: 6, prefetchedAt: meta.prefetchedAt, memberships, ranges, reports }));
  await rename(`${target}.tmp`, target);
  console.log(`Saved ${Object.keys(memberships).length} unique road edges. Unmatched samples: ${Object.values(reports).reduce((n, r) => n + r.unmatched, 0)}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
