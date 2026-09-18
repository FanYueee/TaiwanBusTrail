/**
 * 幾何模組檢查（Phase 3 / 4 / 5 的核心邏輯）
 *
 * 執行：npm run check:geometry
 *
 * 以合成幾何驗證：
 *   1. Shape 區間切割（sliceShapeBetweenStops）
 *   2. 紅/綠覆蓋判定（computeCoverage）
 *   3. 不同路線重疊路段會沿用同一條已走過道路
 *   4. 平行道路（距離大於容差）不會被誤判
 *   5. 容差內的道路會命中、方向相反也會命中
 *   6. 真實 TDX 資料（可選，需 dev server）：--real
 */

import assert from "node:assert/strict";

import {
  buildExploredIndex,
  computeCoverage,
  createToleranceMatcher,
  fuseRoutesByStops,
  haversineMeters,
  maxStopSnapDistance,
  pathLengthMeters,
  sliceShapeBetweenStops,
} from "../src/lib/geometry";
import type { BusStop, LatLon, RideRecord } from "../src/lib/types";

const BASE_LAT = 24.15;
const BASE_LON = 120.68;

/** 將「向東 m 公尺、向北 n 公尺」轉為經緯度 */
function offset(eastMeters: number, northMeters: number): LatLon {
  return {
    lat: BASE_LAT + northMeters / 110574,
    lon: BASE_LON + eastMeters / (111320 * Math.cos((BASE_LAT * Math.PI) / 180)),
  };
}

function makeRecord(geometry: LatLon[], id = "test-record"): RideRecord {
  return {
    id,
    routeUID: "TEST",
    routeID: "TEST",
    routeName: "TEST",
    direction: 0,
    fromStopUID: null,
    toStopUID: null,
    fromStopName: null,
    toStopName: null,
    fullRoute: false,
    geometry,
    createdAt: new Date().toISOString(),
  };
}

function makeStop(stopUID: string, position: LatLon, sequence: number): BusStop {
  return {
    stopUID,
    stopName: stopUID,
    lat: position.lat,
    lon: position.lon,
    sequence,
  };
}

function coveredFlags(chunks: { covered: boolean }[]): boolean[] {
  return chunks.map((chunk) => chunk.covered);
}

// ---------- 測試資料 ----------

// 路線 A：先向東 400m，再向北 400m（含轉折點）
const shapeA: LatLon[] = [
  offset(0, 0),
  offset(100, 0),
  offset(200, 0),
  offset(300, 0),
  offset(400, 0),
  offset(400, 100),
  offset(400, 200),
  offset(400, 300),
  offset(400, 400),
];

const stopsA: BusStop[] = [
  makeStop("A1", offset(0, 0), 1),
  makeStop("A2", offset(200, 0), 2),
  makeStop("A3", offset(400, 0), 3),
  makeStop("A4", offset(400, 200), 4),
  makeStop("A5", offset(400, 400), 5),
];

// ---------- 1. Shape 切割 ----------

const slice = sliceShapeBetweenStops(shapeA, stopsA, "A2", "A4");
assert.ok(slice, "應能切出 A2 → A4 區間");
assert.ok(
  Math.abs(pathLengthMeters(slice.points) - 400) < 5,
  `A2→A4 區間長度應約 400m，實際 ${pathLengthMeters(slice.points).toFixed(1)}m`,
);
assert.ok(
  slice.points.length >= 5,
  "切出的區間應保留轉折點（不是兩點直線）",
);
assert.ok(
  maxStopSnapDistance(shapeA, stopsA) < 1,
  "合成資料的站牌應貼合 Shape",
);

// 反向選取（A4 → A2）仍需對應同一段實際道路
const reverseSlice = sliceShapeBetweenStops(shapeA, stopsA, "A4", "A2");
assert.ok(reverseSlice, "反向選取也應能切出區間");
assert.ok(
  Math.abs(pathLengthMeters(reverseSlice.points) - pathLengthMeters(slice.points)) < 1,
  "正反選取的區間長度應相同",
);

console.log("✓ Shape 切割：A2→A4 取得實際道路區間", {
  points: slice.points.length,
  meters: Math.round(pathLengthMeters(slice.points)),
});

// ---------- 2. 紅/綠覆蓋 ----------

const matcher = createToleranceMatcher(buildExploredIndex([makeRecord(slice.points)]), {
  toleranceMeters: 15,
});

const chunks = computeCoverage(shapeA, matcher, { sampleSpacingMeters: 7.5 });

assert.deepEqual(
  coveredFlags(chunks),
  [false, true, false],
  `應為 紅→綠→紅，實際 ${JSON.stringify(coveredFlags(chunks))}`,
);

const coveredLength = chunks
  .filter((chunk) => chunk.covered)
  .reduce((sum, chunk) => sum + pathLengthMeters(chunk.points), 0);
// 邊界可能因容差（15m）向外延伸，允許最多 2 * tolerance 的過度覆蓋
assert.ok(
  coveredLength >= 400 && coveredLength <= 400 + 2 * 15 + 5,
  `綠色路段長度應介於 400〜435m（容差影響），實際 ${coveredLength.toFixed(1)}m`,
);

console.log("✓ 紅/綠覆蓋：紅→綠→紅，綠色約", Math.round(coveredLength), "m");

// ---------- 3. 重疊路段（不同路線、相同道路） ----------

// 路線 B：在 A2→A4 之間與 A 重疊，但頭尾走不同道路（模擬兩條公車共用部分道路）
const shapeB: LatLon[] = [
  offset(-200, 0),
  offset(-100, 0),
  offset(0, 0),
  ...slice.points,
  offset(400, 450),
  offset(400, 550),
];

const chunksB = computeCoverage(shapeB, matcher, { sampleSpacingMeters: 7.5 });
assert.deepEqual(
  coveredFlags(chunksB),
  [false, true, false],
  "路線 B 與 A 重疊的路段應顯示已走過",
);

const coveredB = chunksB
  .filter((chunk) => chunk.covered)
  .reduce((sum, chunk) => sum + pathLengthMeters(chunk.points), 0);
assert.ok(
  coveredB >= 400 && coveredB <= 400 + 2 * 15 + 10,
  `B 的綠色路段應介於 400〜440m（容差影響），實際 ${coveredB.toFixed(1)}m`,
);

console.log("✓ 重疊路段：不同路線共用道路時正確顯示綠色");

// ---------- 4. 平行道路不可誤判 ----------

// 路線 C：與 A 的東向路段平行、相距 40m（大於容差 15m），且不碰到 A 的南北向路段
const shapeC: LatLon[] = [offset(0, 40), offset(150, 40), offset(300, 40)];
const chunksC = computeCoverage(shapeC, matcher, { sampleSpacingMeters: 7.5 });
assert.deepEqual(
  coveredFlags(chunksC),
  [false],
  "相距 40m 的平行道路不應被視為已走過",
);

// 與已走過路段相距 10m 的同一條道路（GPS/數化誤差）應被視為已走過
const shapeD: LatLon[] = [offset(200, 10), offset(300, 10), offset(400, 10)];
const chunksD = computeCoverage(shapeD, matcher, { sampleSpacingMeters: 7.5 });
assert.deepEqual(
  coveredFlags(chunksD),
  [true],
  "相距 10m 的同一條道路應被視為已走過",
);

console.log("✓ 容差判定：40m 平行道路不算、10m 誤差算");

// ---------- 4b. 方向感知：容差放大時交叉道路仍不誤判 ----------
// 已走過：東西向 x=200..400（slice），容差開到 30m 模擬不同車道差異
const wideMatcher = createToleranceMatcher(
  buildExploredIndex([makeRecord(slice.points)]),
  { toleranceMeters: 30 },
);

// 交叉道路：南北向經過 x=300（與已走過道路垂直）
const crossingRoad: LatLon[] = [offset(300, -60), offset(300, 0), offset(300, 60)];
const crossingChunks = computeCoverage(crossingRoad, wideMatcher, {
  sampleSpacingMeters: 7.5,
});
const crossingCoveredLength = crossingChunks
  .filter((chunk) => chunk.covered)
  .reduce((sum, chunk) => sum + pathLengthMeters(chunk.points), 0);
assert.ok(
  crossingCoveredLength < 35,
  `交叉道路只應在路口附近（距離很近時不看方向）被判為已走過，實際 ${crossingCoveredLength.toFixed(1)}m`,
);

// 平行但不同車道（橫向偏移 20m，小於容差 30m）→ 應視為同一條道路
const parallelOffsetRoad: LatLon[] = [offset(200, 20), offset(300, 20), offset(400, 20)];
const parallelOffsetChunks = computeCoverage(parallelOffsetRoad, wideMatcher, {
  sampleSpacingMeters: 7.5,
});
assert.deepEqual(
  coveredFlags(parallelOffsetChunks),
  [true],
  "相距 20m 的同一方向道路（不同車道）應視為已走過",
);

console.log("✓ 方向感知：30m 容差下交叉道路不誤判、20m 平行車道會命中");

// ---------- 4c. 線段端點外不應過度延伸 ----------
// 已走過路段在 (400, 200) 結束（向北），目標道路繼續往北延伸
const extensionRoad: LatLon[] = [offset(400, 200), offset(400, 260)];
const extensionChunks = computeCoverage(extensionRoad, wideMatcher, {
  sampleSpacingMeters: 7.5,
});
const extensionCoveredLength = extensionChunks
  .filter((chunk) => chunk.covered)
  .reduce((sum, chunk) => sum + pathLengthMeters(chunk.points), 0);
assert.ok(
  extensionCoveredLength < 25,
  `已走過路段終點外只允許少量延伸，實際 ${extensionCoveredLength.toFixed(1)}m`,
);

console.log("✓ 端點處理：已走過路段的終點外不會整段變綠");

// ---------- 5. 反向行駛也會命中 ----------

const reverseRecord = makeRecord([...slice.points].reverse(), "reverse");
const reverseMatcher = createToleranceMatcher(buildExploredIndex([reverseRecord]), {
  toleranceMeters: 15,
});
const reverseChunks = computeCoverage(shapeA, reverseMatcher, {
  sampleSpacingMeters: 7.5,
});
assert.deepEqual(
  coveredFlags(reverseChunks),
  [false, true, false],
  "反向行駛過的同一條道路也應顯示已走過",
);

console.log("✓ 方向無關：反向行駛過的幾何同樣算已走過");

// ---------- 6. 站牌區間融合（合併路網用） ----------
// 重現「路口／轉彎後出現空白」的回歸情境：
//   路線 A 沿同一條路依序停靠 S1~S4；
//   路線 B 跳過 S2（同一條路），S1→S3→S4；
//   路線 C 在 S1→S2 之間繞道北方 40m。
// 期望：
//   - A、B 重疊的路段只畫一條（B 的路線記在代表片段上）
//   - C 的繞道不會被吃掉
//   - 所有片段端點都精確落在站牌座標（共用錨點）→ 路口不會有缺口

const stopS1 = makeStop("S1", offset(0, 0), 1);
const stopS2 = makeStop("S2", offset(100, 0), 2);
const stopS3 = makeStop("S3", offset(200, 0), 3);
const stopS4 = makeStop("S4", offset(300, 0), 4);

const fused = fuseRoutesByStops(
  [
    {
      routeKey: "C:0",
      shape: [offset(0, 0), offset(50, 40), offset(100, 0)],
      stops: [stopS1, stopS2],
    },
    {
      routeKey: "A:0",
      shape: [
        offset(0, 0),
        offset(50, 0),
        offset(100, 0),
        offset(150, 0),
        offset(200, 0),
        offset(250, 0),
        offset(300, 0),
      ],
      stops: [stopS1, stopS2, stopS3, stopS4],
    },
    {
      routeKey: "B:0",
      shape: [offset(0, 0), offset(100, 0), offset(200, 0), offset(300, 0)],
      stops: [stopS1, stopS3, stopS4],
    },
  ],
  { keepToleranceMeters: 12, maxSnapMeters: 25 },
);

const stopPositions = [stopS1, stopS2, stopS3, stopS4];
const isStopPosition = (point: LatLon) =>
  stopPositions.some((stop) => haversineMeters(point, stop) < 0.5);

assert.ok(
  fused.some((slice) => slice.points.some((point) => point.lat > offset(0, 35).lat)),
  "繞道（不同走法）的路段必須保留",
);
assert.ok(
  fused.some(
    (slice) => slice.routeKey === "B:0" || slice.extraRouteKeys.includes("B:0"),
  ),
  "被融合路段的路線 key 應保留在代表片段上（popup 用）",
);
assert.ok(
  fused.every(
    (slice) =>
      isStopPosition(slice.points[0]) &&
      isStopPosition(slice.points[slice.points.length - 1]),
  ),
  "融合後所有片段端點都必須精確落在站牌座標（共用錨點）",
);
const s1ToS2 = fused.filter(
  (slice) =>
    haversineMeters(slice.points[0], stopS1) < 0.5 &&
    haversineMeters(slice.points[slice.points.length - 1], stopS2) < 0.5,
);
assert.equal(s1ToS2.length, 2, "S1→S2 應保留直行與繞道各一條");

console.log(
  `✓ 站牌融合：重疊只畫一條（片段 ${fused.length}）、繞道保留、端點精準錨定站牌`,
);

// ---------- 7. 真實 TDX 資料（可選） ----------

async function runRealDataChecks(): Promise<void> {
  if (!process.argv.includes("--real")) return;

  const baseUrl = process.env.TCBUS_BASE_URL ?? "http://localhost:3000";
  const routeUID = process.argv[process.argv.indexOf("--real") + 1] ?? "TXG300";

  const shapeResponse = await fetch(
    `${baseUrl}/api/tdx/shapes?routeUID=${routeUID}&direction=0`,
  );
  const { shape } = (await shapeResponse.json()) as {
    shape: { geometry: LatLon[] } | null;
  };
  const stopsResponse = await fetch(
    `${baseUrl}/api/tdx/stops?routeUID=${routeUID}&direction=0`,
  );
  const { stops } = (await stopsResponse.json()) as { stops: BusStop[] };

  assert.ok(shape, `真實資料 ${routeUID} 應有 Shape`);
  assert.ok(stops.length > 2, `真實資料 ${routeUID} 應有站牌`);

  const first = stops[0];
  const fifth = stops[Math.min(4, stops.length - 1)];
  const realSlice = sliceShapeBetweenStops(shape.geometry, stops, first.stopUID, fifth.stopUID);
  assert.ok(realSlice, "真實資料應能切出區間");

  const realMatcher = createToleranceMatcher(
    buildExploredIndex([makeRecord(realSlice.points)]),
    { toleranceMeters: 15 },
  );
  const realChunks = computeCoverage(shape.geometry, realMatcher, {
    sampleSpacingMeters: 7.5,
  });
  const realCovered = realChunks
    .filter((chunk) => chunk.covered)
    .reduce((sum, chunk) => sum + pathLengthMeters(chunk.points), 0);

  console.log(
    `✓ 真實資料 ${routeUID}：Shape ${shape.geometry.length} 點、站牌 ${stops.length} 站、` +
      `切出 ${first.stopName}→${fifth.stopName} ${Math.round(pathLengthMeters(realSlice.points))}m、` +
      `覆蓋判定 ${Math.round(realCovered)}m、區塊 ${coveredFlags(realChunks).join(",")}`,
  );
}

runRealDataChecks()
  .then(() => {
    console.log("\n所有幾何檢查通過");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
