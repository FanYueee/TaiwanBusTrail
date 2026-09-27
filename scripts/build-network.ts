import { readFile, writeFile, rename } from "node:fs/promises";
import { ReferenceRoadGraph } from "../src/lib/geometry/referenceRoads";
import { buildRoadDisplay, type RoadDisplayStats, type RoadDisplayDiagnostics } from "../src/lib/geometry/roadDisplay";
import { packNetwork } from "../src/lib/geometry/networkFormat";
import { shapeFingerprint } from "../src/lib/geometry/shapeFingerprint";
import { validateRoadDisplay, auditDisplayConnectivity } from "../src/lib/geometry/displayValidation";
import { haversineMeters } from "../src/lib/geometry/distance";
import { tdxDataFile } from "../src/lib/tdx/dataDir";

async function main() {
  const started = performance.now();
  const read = async (name: string) => JSON.parse(await readFile(tdxDataFile(`${name}.json`), "utf8"));
  const [roads, matches, meta, shapes] = await Promise.all(["roads", "road-matches", "meta", "shapes"].map(read));
  if (matches.version !== 2 || matches.algorithmVersion !== 6 || matches.prefetchedAt !== meta.prefetchedAt) throw new Error("路線資料或匹配演算法已更新，請先執行 npm run match:roads");
  const graph = new ReferenceRoadGraph(roads.ways, roads.stations);
  console.log("Building fixed road corridors…");
  const gapAudit: RoadDisplayStats = { completedGaps: 0, completedGapEdges: 0 };
  const diagnostics: RoadDisplayDiagnostics = { includeConstraints: true };
  const network = buildRoadDisplay(graph, matches.memberships, matches.ranges, gapAudit, diagnostics);
  if (gapAudit.anchorConflicts || gapAudit.corridorReversals) throw new Error(`中央線幾何檢查失敗，不覆寫現有路網：${JSON.stringify(gapAudit)}`);
  const nativeNodes = new Map<number, { lat: number; lon: number }>();
  for (const edge of graph.edges) { nativeNodes.set(edge.from, edge.a); nativeNodes.set(edge.to, edge.b); }
  const excessiveJunctions = (diagnostics.constraints ?? []).flatMap((constraint) => [...constraint.nodes].map((node) => ({
    node, meters: haversineMeters(nativeNodes.get(node)!, constraint.point),
  }))).filter((entry) => entry.meters > 50);
  if (excessiveJunctions.length) throw new Error(`路口移動超過 50m，不覆寫現有路網：${JSON.stringify(excessiveJunctions.slice(0, 10))}`);
  const displayAudit = { ...validateRoadDisplay(graph, network, matches.memberships), ...gapAudit,
    junctionExcursions: Object.values(matches.reports as Record<string, { junctionExcursions: number }>).reduce((n, r) => n + r.junctionExcursions, 0) };
  const connectivity = auditDisplayConnectivity(graph, network, matches.ranges, new Set(diagnostics.collapsedRanges));
  if (connectivity.gaps.length) throw new Error(`原始接點在顯示路網中斷裂，不覆寫現有路網：${JSON.stringify(connectivity.gaps.slice(0, 10))}`);
  Object.assign(displayAudit, { checkedConnections: connectivity.checked, disconnectedConnections: connectivity.gaps.length, collapsedTraversals: connectivity.collapsedTraversals });
  console.log(`連通檢查：${connectivity.checked} 組原始接點，超過 0.25 公尺的斷口 ${connectivity.gaps.length}；${gapAudit.inferredSideWays ?? 0} 條未命名側車道共線`);
  console.log(`自動檢查：消除 ${displayAudit.junctionExcursions} 次路口零進展往返，補齊 ${gapAudit.completedGaps} 處車道合併缺口（${gapAudit.completedGapEdges} 段）`);
  console.log(`中央線檢查：衝突錨點 ${gapAudit.anchorConflicts}、反向折返 ${gapAudit.corridorReversals}；${gapAudit.reroutedTurns ?? 0} 處轉向共線、${gapAudit.smoothedRampWays ?? 0} 條匝道平順銜接`);
  const represented = new Set(network.flatMap((chain) => chain.routeKeys));
  for (const [key, report] of Object.entries(matches.reports) as [string, { edges: number }][]) {
    if (report.edges > 0 && !represented.has(key)) throw new Error(`建置遺失路線 ${key}，不覆寫現有路網`);
  }
  const shapeHashes = Object.fromEntries(Object.keys(matches.reports).map((key) => [key, shapeFingerprint(shapes[key]?.geometry ?? [])]));
  const payload = JSON.stringify({ version: 4, prefetchedAt: meta.prefetchedAt, source: roads.source, reports: matches.reports, shapeHashes, displayAudit, network: packNetwork(network) });
  await writeFile(tdxDataFile("network.json.tmp"), payload);
  await rename(tdxDataFile("network.json.tmp"), tdxDataFile("network.json"));
  console.log(`道路骨架：${network.length} 個區段，${(payload.length / 1024 / 1024).toFixed(2)} MB，${((performance.now() - started) / 1000).toFixed(1)} 秒`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
