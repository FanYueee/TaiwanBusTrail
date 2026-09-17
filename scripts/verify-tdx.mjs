#!/usr/bin/env node
/**
 * Phase 1：TDX 台中市公車資料驗證腳本
 *
 * 目的：
 *   1. 以真實 TDX API 取得台中市公車 Route / StopOfRoute / Shape
 *   2. 確認 Shape 是真實道路線型（含轉折），不是站牌之間的直線
 *   3. 產出 docs/tdx-verification.md
 *
 * 使用方式：
 *   1. 在專案根目錄建立 .env.local，填入 TDX_CLIENT_ID / TDX_CLIENT_SECRET
 *   2. npm run verify:tdx
 *   3. 可用參數指定路線：node scripts/verify-tdx.mjs 300 5 35
 *
 * 注意：TDX 免費方案限制 5 requests / 分鐘（x-ratelimit-limit-minute）。
 *       本腳本會自動限速並於 429 時依 ratelimit-reset 重試。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const AUTH_URL =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const API_BASE = "https://tdx.transportdata.tw/api/basic/v2/Bus";
const CITY = "Taichung";

const DEFAULT_ROUTES = ["300", "5", "35", "307", "33"];

/** 全域最小請求間隔：TDX 限制 5/min，保守用 4/min = 15s */
const MIN_REQUEST_INTERVAL_MS = 15_000;

// ---------- env ----------

function loadEnv() {
  const files = [".env.local", ".env"];
  const env = { ...process.env };
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (env[m[1]] === undefined) env[m[1]] = v;
    }
  }
  return env;
}

const env = loadEnv();

if (!env.TDX_ACCESS_TOKEN && (!env.TDX_CLIENT_ID || !env.TDX_CLIENT_SECRET)) {
  console.error(
    [
      "找不到 TDX 憑證。",
      "",
      "請在專案根目錄建立 .env.local（可從 .env.example 複製），內容例如：",
      "  TDX_CLIENT_ID=your-client-id",
      "  TDX_CLIENT_SECRET=your-client-secret",
      "",
      "憑證申請：https://tdx.transportdata.tw/",
    ].join("\n"),
  );
  process.exit(2);
}

// ---------- TDX client（含限速與 429 重試） ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastRequestAt = 0;

async function getToken() {
  if (env.TDX_ACCESS_TOKEN) return env.TDX_ACCESS_TOKEN;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.TDX_CLIENT_ID,
    client_secret: env.TDX_CLIENT_SECRET,
  });
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`取得 TDX token 失敗：HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error("TDX token 回應缺少 access_token");
  return json.access_token;
}

async function throttle() {
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

async function tdxGet(token, url) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    await throttle();
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (res.ok) return res.json();

    const text = await res.text();
    lastErr = new Error(`GET ${url} 失敗：HTTP ${res.status} ${text.slice(0, 200)}`);
    if (res.status === 429 || res.status >= 500) {
      const resetSec = Number(res.headers.get("ratelimit-reset") ?? 60);
      const wait = (Number.isFinite(resetSec) ? resetSec + 1 : 61) * 1000;
      console.log(`  … TDX HTTP ${res.status}，依 rate-limit 等待 ${Math.round(wait / 1000)}s 後重試`);
      lastRequestAt = Date.now();
      await sleep(wait);
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

function apiUrl(resource, params) {
  const qs = new URLSearchParams(params);
  return `${API_BASE}/${resource}/City/${CITY}?${qs.toString()}`;
}

// ---------- geometry helpers ----------

const R = 6371008.8;

function toRad(d) {
  return (d * Math.PI) / 180;
}

function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function pathLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i]);
  return d;
}

function pointToSegmentMeters(p, a, b) {
  const lat0 = toRad((a.lat + b.lat) / 2);
  const mx = (d) => d * Math.cos(lat0) * 111320;
  const my = (d) => d * 110540;
  const ax = mx(a.lon), ay = my(a.lat);
  const bx = mx(b.lon), by = my(b.lat);
  const px = mx(p.lon), py = my(p.lat);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function minDistanceToPolyline(p, poly) {
  let min = Infinity;
  for (let i = 1; i < poly.length; i++) {
    min = Math.min(min, pointToSegmentMeters(p, poly[i - 1], poly[i]));
  }
  return min;
}

function nearestIndex(p, poly) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d = haversine(p, poly[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return { index: best, distance: bestD };
}

// ---------- geometry format detection ----------

function parseWktLineString(wkt) {
  const m = wkt.match(/LINESTRING\s*\(([^)]*)\)/i);
  if (!m) return null;
  const pts = m[1]
    .split(",")
    .map((pair) => pair.trim().split(/\s+/))
    .map(([lon, lat]) => ({ lon: Number(lon), lat: Number(lat) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  return pts.length >= 2 ? pts : null;
}

function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision;
  const points = [];
  let lat = 0;
  let lon = 0;
  let i = 0;
  while (i < str.length) {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && i < str.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && i < str.length);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / factor, lon: lon / factor });
  }
  return points.length >= 2 ? points : null;
}

/** 從 TDX Shape 物件解析出座標陣列，支援 WKT / encoded polyline / 陣列 */
function extractGeometry(shapeObj) {
  const raw =
    shapeObj.Geometry ??
    shapeObj.EncodedPolyline ??
    shapeObj.geometry ??
    shapeObj.WKT ??
    null;
  if (raw == null) return { format: "missing", points: null, rawSample: null };

  if (typeof raw === "string") {
    if (/LINESTRING/i.test(raw)) {
      return {
        format: "WKT LINESTRING",
        points: parseWktLineString(raw),
        rawSample: raw.slice(0, 160),
      };
    }
    return {
      format: "encoded polyline",
      points: decodePolyline(raw),
      rawSample: raw.slice(0, 160),
    };
  }
  if (Array.isArray(raw)) {
    const pts = raw.map((p) =>
      Array.isArray(p) ? { lat: Number(p[0]), lon: Number(p[1]) } : p,
    );
    return {
      format: "array",
      points: pts.length >= 2 ? pts : null,
      rawSample: JSON.stringify(raw).slice(0, 160),
    };
  }
  return {
    format: `unknown(${typeof raw})`,
    points: null,
    rawSample: JSON.stringify(raw).slice(0, 160),
  };
}

// ---------- route analysis ----------

function analyzeRouteShape(stops, shapePoints) {
  const stopPts = stops.map((s) => ({
    name: s.StopName?.Zh_tw ?? s.StopName ?? "?",
    lat: s.StopPosition?.PositionLat,
    lon: s.StopPosition?.PositionLon,
  }));

  const shapeLen = pathLength(shapePoints);
  const stopPolyLen = pathLength(stopPts);
  const straightRatio = stopPolyLen > 0 ? shapeLen / stopPolyLen : null;

  let maxOffset = 0;
  for (const p of shapePoints) {
    maxOffset = Math.max(maxOffset, minDistanceToPolyline(p, stopPts));
  }

  const pairStats = [];
  for (let i = 1; i < stopPts.length; i++) {
    const a = nearestIndex(stopPts[i - 1], shapePoints);
    const b = nearestIndex(stopPts[i], shapePoints);
    const lo = Math.min(a.index, b.index);
    const hi = Math.max(a.index, b.index);
    const roadDist = pathLength(shapePoints.slice(lo, hi + 1));
    const straight = haversine(stopPts[i - 1], stopPts[i]);
    if (straight < 20) continue;
    pairStats.push({
      ratio: roadDist / straight,
      from: stopPts[i - 1].name,
      to: stopPts[i].name,
    });
  }
  const bendyPairs = pairStats.filter((p) => p.ratio > 1.15).length;

  return {
    shapeLen,
    stopPolyLen,
    straightRatio,
    maxOffset,
    stopCount: stopPts.length,
    shapePointCount: shapePoints.length,
    pairCount: pairStats.length,
    bendyPairs,
    maxPairRatio: pairStats.length ? Math.max(...pairStats.map((p) => p.ratio)) : null,
  };
}

function fmt(n, digits = 1) {
  return Number(n).toFixed(digits);
}

function orFilter(uids, dir) {
  const parts = uids.map((u) => `RouteUID eq '${u}'`).join(" or ");
  return `(${parts}) and Direction eq ${dir}`;
}

// ---------- main ----------

async function main() {
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ROUTES;
  console.log("TDX 台中市公車資料驗證");
  console.log("=======================");

  const token = await getToken();
  console.log("✓ 取得 TDX access token");

  const routesUrl = apiUrl("Route", {
    $format: "JSON",
    $top: "1000",
    $select:
      "RouteUID,RouteID,RouteName,DepartureStopNameZh,DestinationStopNameZh,SubRoutes,UpdateTime",
  });
  const routes = await tdxGet(token, routesUrl);
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error("Route 回應為空，無法繼續驗證");
  }

  // 攤平 SubRoutes：TDX 台中 Route 的方向資訊在 SubRoutes[] 內
  const flattened = [];
  for (const route of routes) {
    for (const sub of route.SubRoutes ?? []) {
      flattened.push({
        routeUID: sub.SubRouteUID ?? route.RouteUID,
        routeID: sub.SubRouteID ?? route.RouteID,
        routeName: route.RouteName?.Zh_tw ?? sub.SubRouteName?.Zh_tw ?? "?",
        subRouteName: sub.SubRouteName?.Zh_tw ?? "",
        direction: sub.Direction ?? 0,
        headsign: sub.Headsign ?? "",
        departure: route.DepartureStopNameZh,
        destination: route.DestinationStopNameZh,
      });
    }
  }
  console.log(
    `✓ 取得台中市公車 Route 共 ${routes.length} 條、攤平後 ${flattened.length} 筆（含方向）`,
  );

  // 依路線名稱挑選目標（每個名稱取去程/返程各一筆）
  const targets = [];
  for (const name of wanted) {
    const matchName = (n) =>
      n === name || n.startsWith(`${name}路`) || n.startsWith(`${name} `);
    const matched = flattened
      .filter((r) => matchName(r.routeName) || matchName(r.subRouteName))
      .sort((a, b) => a.direction - b.direction);
    if (matched.length === 0) {
      console.log(`- ${name}：找不到路線，略過`);
      continue;
    }
    const dir0 = matched.find((r) => r.direction === 0) ?? matched[0];
    const dir1 = matched.find((r) => r.direction === 1);
    targets.push({ name, routes: dir1 && dir1 !== dir0 ? [dir0, dir1] : [dir0] });
  }

  const targetUIDs = [...new Set(targets.flatMap((t) => t.routes.map((r) => r.routeUID)))];
  console.log(`\n批次查詢 ${targetUIDs.length} 條路線的 Shape / StopOfRoute…`);

  // 每個方向各一次 Shape + 一次 StopOfRoute（合併 filter，節省 rate limit）
  const shapeByKey = new Map();
  const stopsByKey = new Map();
  for (const dir of [0, 1]) {
    const uids = targets
      .flatMap((t) => t.routes)
      .filter((r) => r.direction === dir)
      .map((r) => r.routeUID);
    if (uids.length === 0) continue;

    const shapes = await tdxGet(
      token,
      apiUrl("Shape", {
        $format: "JSON",
        $filter: orFilter(uids, dir),
        $top: "100",
      }),
    );
    for (const s of shapes) shapeByKey.set(`${s.RouteUID}:${s.Direction}`, s);

    const stopOfRoutes = await tdxGet(
      token,
      apiUrl("StopOfRoute", {
        $format: "JSON",
        $filter: orFilter(uids, dir),
        $top: "100",
      }),
    );
    for (const s of stopOfRoutes) stopsByKey.set(`${s.RouteUID}:${s.Direction}`, s);
  }

  // 逐條分析
  const results = [];
  for (const target of targets) {
    console.log(`\n── 路線 ${target.name}`);
    for (const route of target.routes) {
      const key = `${route.routeUID}:${route.direction}`;
      const dirText = route.direction === 0 ? "去程" : "返程";
      const label = `${target.name} ${dirText} (${route.routeUID})`;
      const shapeObj = shapeByKey.get(key);
      const stopObj = stopsByKey.get(key);

      if (!shapeObj) {
        console.log(`  ✗ ${label}：TDX 無 Shape 資料`);
        results.push({
          name: target.name,
          routeUID: route.routeUID,
          direction: route.direction,
          routeID: route.routeID,
          departure: route.departure,
          destination: route.destination,
          error: "TDX 無 Shape 資料",
          shapeField: [],
        });
        continue;
      }

      const geo = extractGeometry(shapeObj);
      const stops = stopObj?.Stops ?? [];
      const analysis = geo.points ? analyzeRouteShape(stops, geo.points) : null;
      const isRealRoad =
        analysis != null && analysis.maxOffset > 25 && analysis.bendyPairs > 0;

      console.log(
        `  ✓ ${label}：Shape ${geo.points?.length ?? 0} 點（${geo.format}）、` +
          `站牌 ${analysis?.stopCount ?? 0} 站、` +
          `Shape 長度 ${analysis ? fmt(analysis.shapeLen) : "?"} m、` +
          `與站牌連線最大偏移 ${analysis ? fmt(analysis.maxOffset) : "?"} m、` +
          `彎曲區間 ${analysis?.bendyPairs ?? "?"}/${analysis?.pairCount ?? "?"}`,
      );
      console.log(
        `     判定：${isRealRoad ? "是實際道路線型（非站牌直線）" : "資料不足，需人工複核"}`,
      );

      results.push({
        name: target.name,
        routeUID: route.routeUID,
        direction: route.direction,
        routeID: route.routeID,
        departure: route.departure,
        destination: route.destination,
        headsign: route.headsign,
        shapeField: Object.keys(shapeObj),
        format: geo.format,
        rawSample: geo.rawSample,
        firstPoints: (geo.points ?? []).slice(0, 5),
        lastPoints: (geo.points ?? []).slice(-3),
        stops: stops.slice(0, 5).map((s) => ({
          name: s.StopName?.Zh_tw ?? "?",
          sequence: s.StopSequence,
          lat: s.StopPosition?.PositionLat,
          lon: s.StopPosition?.PositionLon,
        })),
        analysis,
        isRealRoad,
        updatedAt: shapeObj.UpdateTime ?? null,
      });
    }
  }

  // ---------- 寫出文件 ----------

  const now = new Date();
  const lines = [];
  lines.push("# TDX 台中市公車 Shape 資料驗證（Phase 1）");
  lines.push("");
  lines.push(`> 驗證時間：${now.toISOString()}`);
  lines.push("> 驗證方式：實際呼叫交通部 TDX 官方 API（本文件由 `scripts/verify-tdx.mjs` 產生）");
  lines.push("");
  lines.push("## API Endpoint");
  lines.push("");
  lines.push("| 用途 | Endpoint |");
  lines.push("| --- | --- |");
  lines.push(`| 取得 token | \`POST ${AUTH_URL}\`（grant_type=client_credentials） |`);
  lines.push(`| Route | \`GET ${API_BASE}/Route/City/${CITY}?$format=JSON\` |`);
  lines.push(
    `| Shape | \`GET ${API_BASE}/Shape/City/${CITY}?$format=JSON&$filter=RouteUID eq '…' and Direction eq 0\` |`,
  );
  lines.push(
    `| StopOfRoute | \`GET ${API_BASE}/StopOfRoute/City/${CITY}?$format=JSON&$filter=RouteUID eq '…' and Direction eq 0\` |`,
  );
  lines.push("");
  lines.push("### 實際觀察到的資料結構");
  lines.push("");
  lines.push("- `Route`：台中市資料的**方向資訊在 `SubRoutes[]` 內**，外層沒有 `Direction` 欄位。每筆 SubRoute 有 `SubRouteUID`、`SubRouteID`、`Direction`（0=去程、1=返程）、`Headsign`。");
  lines.push("- `Shape`：回傳欄位 `RouteUID, RouteID, RouteName, SubRouteUID, SubRouteID, SubRouteName, Direction, Geometry, EncodedPolyline, UpdateTime, VersionID`。");
  lines.push("- `Geometry` 為 **WKT `LINESTRING(經度 緯度, …)`** 字串；另有 `EncodedPolyline` 欄位可作為備援。");
  lines.push("- `StopOfRoute`：`Stops[]` 內含 `StopUID, StopName.Zh_tw, StopSequence, StopPosition.PositionLat/PositionLon`。");
  lines.push("- **TDX 速率限制：`x-ratelimit-limit-minute: 5`，即每分鐘 5 次請求**。App 端因此採用「隨選抓取 + IndexedDB 快取」，避免反覆大量請求。");
  lines.push("");
  lines.push(`台中市公車路線總筆數（Route）：**${routes.length}**，攤平後（含方向/變體）：**${flattened.length}**`);
  lines.push("");
  lines.push("## 驗證結果");
  lines.push("");
  lines.push(
    "| 路線 | 方向 | RouteUID | Shape 格式 | Shape 點數 | 站牌數 | Shape 長度 (m) | 與站牌直線最大偏移 (m) | 彎曲區間 / 總區間 | 判定 |",
  );
  lines.push(
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  );

  for (const r of results) {
    const dirText = r.direction === 0 ? "去程" : r.direction === 1 ? "返程" : "-";
    if (r.error) {
      lines.push(
        `| ${r.name} | ${dirText} | ${r.routeUID ?? "-"} | - | - | - | - | - | - | ${r.error} |`,
      );
      continue;
    }
    const a = r.analysis;
    lines.push(
      `| ${r.name} | ${dirText} | \`${r.routeUID}\` | ${r.format} | ${a.shapePointCount} | ${a.stopCount} | ${fmt(a.shapeLen)} | ${fmt(a.maxOffset)} | ${a.bendyPairs} / ${a.pairCount} | ${r.isRealRoad ? "✅ 實際道路線型" : "⚠️ 需複核"} |`,
    );
  }
  lines.push("");
  lines.push("### 判定方式");
  lines.push("");
  lines.push(
    "- **與站牌直線最大偏移**：將站牌依 sequence 連成折線後，計算 Shape 每個頂點到該折線的最近距離（公尺）。若只是把站牌連直線，此值應接近 0；實際道路線型會出現數十至數百公尺的偏移。",
  );
  lines.push(
    "- **彎曲區間**：對每組相鄰站牌，取 Shape 對應區段的實際道路長度 ÷ 兩站直線距離。比值 > 1.15 視為該區間具有實際道路轉折。",
  );
  lines.push("- **Shape 長度 vs 站牌折線長度**：實際線型通常大於站牌折線總長（見原始數據）。");
  lines.push("");

  const okCount = results.filter((r) => r.isRealRoad).length;
  const noShape = results.filter((r) => r.error).length;
  lines.push("## 結論");
  lines.push("");
  if (okCount > 0) {
    lines.push(
      `- ✅ 已實際取得 **${okCount}** 條台中市公車路線（含方向）的 TDX Shape，內容包含站牌之間的道路轉折，**不是 stop-to-stop 直線**。`,
    );
  }
  if (noShape > 0) {
    lines.push(
      `- ⚠️ 有 ${noShape} 條測試路線 TDX 沒有回傳 Shape，App 會將其標示為「無可用線型資料」，不會以站牌直線代替。`,
    );
  }
  lines.push(
    "- Shape 欄位格式與座標點數量見上表；程式端（`src/lib/tdx/geometryParser.ts`）同時支援 WKT LINESTRING 與 encoded polyline。",
  );
  lines.push("");

  lines.push("## 範例 Shape 資料");
  lines.push("");
  for (const r of results.filter((x) => !x.error).slice(0, 2)) {
    lines.push(`### ${r.name} 路（${r.direction === 0 ? "去程" : "返程"}）`);
    lines.push("");
    lines.push(`- RouteUID：\`${r.routeUID}\``);
    lines.push(`- Shape 原始欄位：\`${JSON.stringify(r.shapeField)}\``);
    lines.push(`- 格式：\`${r.format}\``);
    lines.push(`- Shape 點數：${r.analysis.shapePointCount}，站牌數：${r.analysis.stopCount}`);
    lines.push(`- 原始內容開頭：\`${String(r.rawSample).replace(/`/g, "\\`")}\``);
    lines.push("");
    lines.push("- 前 5 個座標點：");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(r.firstPoints, null, 2));
    lines.push("```");
    lines.push("");
    lines.push("- 最後 3 個座標點：");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(r.lastPoints, null, 2));
    lines.push("```");
    lines.push("");
    lines.push("- 前 5 站：");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(r.stops, null, 2));
    lines.push("```");
    lines.push("");
  }

  const docsDir = path.join(ROOT, "docs");
  fs.mkdirSync(docsDir, { recursive: true });
  const outPath = path.join(docsDir, "tdx-verification.md");
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(`\n已寫入 ${outPath}`);

  const failed = results.filter((r) => r.isRealRoad !== true);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\n驗證失敗：", err.message);
  process.exit(1);
});
