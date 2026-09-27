#!/usr/bin/env node
/**
 * 預先下載指定縣市公車全部 Shape / StopOfRoute
 *
 * 執行：npm run prefetch:tdx
 *
 * 利用 TDX 的 OData OR filter 批次查詢（每批 50 條 RouteUID），
 * 全部約 30 次請求、約 8 分鐘完成（TDX 限 5 requests/分鐘）。
 * 下載結果寫入 data/tdx/{routes,shapes,stops,meta}.json，
 * App 會優先讀取這份本地資料，之後選路線即可秒開。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const AUTH_URL =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const API_BASE = "https://tdx.transportdata.tw/api/basic/v2/Bus";

const BATCH_SIZE = 50;
/** TDX 限 5 requests/分鐘，保守 4/min */
const MIN_REQUEST_INTERVAL_MS = 15_000;

// ---------- env ----------

function loadEnv() {
  const env = { ...process.env };
  for (const file of [".env.local", ".env"]) {
    const filePath = path.join(ROOT, file);
    if (!fs.existsSync(filePath)) continue;
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (env[match[1]] === undefined) env[match[1]] = value;
    }
  }
  return env;
}

const env = loadEnv();
const DATA_DIR = path.resolve(ROOT, env.TCBUS_DATA_DIR || "data/tdx");
const CITY = env.TCBUS_CITY || "Taichung";
if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(CITY)) {
  throw new Error(`Invalid TCBUS_CITY: ${CITY}`);
}
if (!env.TDX_ACCESS_TOKEN && (!env.TDX_CLIENT_ID || !env.TDX_CLIENT_SECRET)) {
  console.error("找不到 TDX 憑證，請先在 .env.local 設定 TDX_CLIENT_ID / TDX_CLIENT_SECRET");
  process.exit(2);
}

// ---------- TDX client（限速 + 429 重試） ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastRequestAt = 0;

async function throttle() {
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

let token = null;

async function getToken() {
  if (env.TDX_ACCESS_TOKEN) return env.TDX_ACCESS_TOKEN;
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.TDX_CLIENT_ID,
      client_secret: env.TDX_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`取得 token 失敗：HTTP ${res.status}`);
  const json = await res.json();
  if (!json.access_token) throw new Error("token 回應缺少 access_token");
  return json.access_token;
}

async function tdxGet(resource, params) {
  if (!token) token = await getToken();
  const url = `${API_BASE}/${resource}/City/${CITY}?${new URLSearchParams(params).toString()}`;

  for (let attempt = 0; attempt < 6; attempt++) {
    await throttle();
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (res.ok) return res.json();

    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      const reset = Number(res.headers.get("ratelimit-reset"));
      const waitMs = (Number.isFinite(reset) ? reset + 1 : 61) * 1000;
      console.log(`  … HTTP ${res.status}，等待 ${Math.round(waitMs / 1000)}s 後重試`);
      lastRequestAt = Date.now();
      await sleep(waitMs);
      continue;
    }
    throw new Error(`GET ${url} 失敗：HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  throw new Error(`GET ${url} 失敗：已達重試上限`);
}

async function tdxGetAll(resource, params) {
  const pageSize = 1000;
  const rows = [];
  for (let skip = 0; ; skip += pageSize) {
    const page = await tdxGet(resource, { ...params, $top: String(pageSize), $skip: String(skip) });
    if (!Array.isArray(page)) throw new Error(`${resource} 回應不是資料陣列`);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

// ---------- 幾何解析 ----------

function parseWktLineString(wkt) {
  const match = wkt.match(/LINESTRING\s*\(([^)]*)\)/i);
  if (!match) return null;
  const points = [];
  for (const pair of match[1].split(",")) {
    const [lonText, latText] = pair.trim().split(/\s+/);
    const lon = Number(lonText);
    const lat = Number(latText);
    if (Number.isFinite(lat) && Number.isFinite(lon)) points.push({ lat, lon });
  }
  return points.length >= 2 ? points : null;
}

function decodePolyline(encoded, precision = 5) {
  const factor = 10 ** precision;
  const points = [];
  let lat = 0;
  let lon = 0;
  let index = 0;
  const decodeValue = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      if (index >= encoded.length) return null;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    const dLat = decodeValue();
    const dLon = decodeValue();
    if (dLat === null || dLon === null) return null;
    lat += dLat;
    lon += dLon;
    points.push({ lat: lat / factor, lon: lon / factor });
  }
  return points.length >= 2 ? points : null;
}

function parseGeometry(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    return /LINESTRING/i.test(raw) ? parseWktLineString(raw) : decodePolyline(raw);
  }
  if (Array.isArray(raw)) {
    const points = [];
    for (const item of raw) {
      if (Array.isArray(item) && item.length >= 2) {
        const lat = Number(item[0]);
        const lon = Number(item[1]);
        if (Number.isFinite(lat) && Number.isFinite(lon)) points.push({ lat, lon });
      }
    }
    return points.length >= 2 ? points : null;
  }
  return null;
}

// ---------- 正規化 ----------

function normalizeRoutes(rawRoutes) {
  const result = [];
  for (const route of rawRoutes) {
    const routeUID = route.RouteUID;
    const routeID = route.RouteID;
    if (!routeUID || !routeID) continue;
    const routeName = route.RouteName?.Zh_tw ?? routeID;
    const subs = route.SubRoutes?.length
      ? route.SubRoutes
      : [{ SubRouteUID: routeUID, SubRouteID: routeID, Direction: 0 }];
    for (const sub of subs) {
      const direction = sub.Direction === 1 ? 1 : 0;
      const departure =
        direction === 0 ? route.DepartureStopNameZh : route.DestinationStopNameZh;
      const destination =
        direction === 0 ? route.DestinationStopNameZh : route.DepartureStopNameZh;
      const subRouteName = sub.SubRouteName?.Zh_tw ?? null;
      result.push({
        routeUID: sub.SubRouteUID ?? routeUID,
        routeID: sub.SubRouteID ?? routeID,
        routeName,
        subRouteName: subRouteName && subRouteName !== routeName ? subRouteName : null,
        direction,
        departureStop: departure ?? "",
        destinationStop: destination ?? "",
        headsign: sub.Headsign ?? "",
        operatorIDs: (route.Operators ?? []).map((operator) => operator.OperatorID ?? ""),
        operatorNames: (route.Operators ?? []).map(
          (operator) => operator.OperatorName?.Zh_tw ?? operator.OperatorID ?? "",
        ),
      });
    }
  }
  return result;
}

function normalizeStops(rawStopOfRoute) {
  const stops = [];
  for (const stop of rawStopOfRoute.Stops ?? []) {
    const lat = stop.StopPosition?.PositionLat;
    const lon = stop.StopPosition?.PositionLon;
    if (!stop.StopUID || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    stops.push({
      stopUID: stop.StopUID,
      stopName: stop.StopName?.Zh_tw ?? stop.StopUID,
      lat,
      lon,
      sequence: stop.StopSequence ?? stops.length + 1,
    });
  }
  stops.sort((a, b) => a.sequence - b.sequence);
  return stops;
}

function cacheKey(routeUID, direction) {
  return `${routeUID}:${direction}`;
}

function orFilter(uids) {
  return uids.map((uid) => `RouteUID eq '${uid}'`).join(" or ");
}

// ---------- 主流程 ----------

async function main() {
  const startedAt = Date.now();
  console.log(`TDX ${CITY} 公車線型預先下載`);
  console.log("============================");

  const rawRoutes = await tdxGetAll("Route", {
    $format: "JSON",
    $select:
      "RouteUID,RouteID,RouteName,DepartureStopNameZh,DestinationStopNameZh,SubRoutes,Operators,UpdateTime",
  });
  const routes = normalizeRoutes(rawRoutes);
  if (!routes.length) throw new Error("TDX 沒有回傳可用路線，保留既有資料");
  const uniqueUIDs = [...new Set(rawRoutes.map((route) => route.RouteUID).filter(Boolean))];
  console.log(`✓ 路線 ${routes.length} 筆（${uniqueUIDs.length} 個主 RouteUID）`);

  const batches = [];
  for (let i = 0; i < uniqueUIDs.length; i += BATCH_SIZE) {
    batches.push(uniqueUIDs.slice(i, i + BATCH_SIZE));
  }

  const totalRequests = batches.length * 2 + 1;
  console.log(
    `預計請求 ${totalRequests} 次（每批 ${BATCH_SIZE} 條，Shape + StopOfRoute），` +
      `約 ${Math.ceil((totalRequests * MIN_REQUEST_INTERVAL_MS) / 60000)} 分鐘\n`,
  );

  /** @type {Record<string, {geometry: unknown[] | null, updatedAt: string | null}>} */
  const shapes = {};
  /** @type {Record<string, unknown[]>} */
  const stops = {};
  const warnings = [];

  const expectedKeys = routes.map((route) => cacheKey(route.routeUID, route.direction));

  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    const progress = `[${index + 1}/${batches.length}]`;

    try {
      const shapeRows = await tdxGetAll("Shape", {
        $format: "JSON",
        $filter: orFilter(batch),
      });
      for (const row of Array.isArray(shapeRows) ? shapeRows : []) {
        const uid = row?.SubRouteUID ?? row?.RouteUID;
        if (!uid || (row.Direction !== 0 && row.Direction !== 1)) continue;
        shapes[cacheKey(uid, row.Direction)] = {
          geometry: parseGeometry(row.Geometry ?? row.EncodedPolyline ?? null),
          updatedAt: row.UpdateTime ?? null,
        };
      }
    } catch (error) {
      warnings.push(`Shape batch ${index + 1} 失敗：${error.message}`);
      console.log(`  ✗ ${progress} Shape 批次失敗：${error.message}`);
    }

    try {
      const stopRows = await tdxGetAll("StopOfRoute", {
        $format: "JSON",
        $filter: orFilter(batch),
      });
      for (const row of Array.isArray(stopRows) ? stopRows : []) {
        const uid = row?.SubRouteUID ?? row?.RouteUID;
        if (!uid || (row.Direction !== 0 && row.Direction !== 1)) continue;
        stops[cacheKey(uid, row.Direction)] = normalizeStops(row);
      }
    } catch (error) {
      warnings.push(`StopOfRoute batch ${index + 1} 失敗：${error.message}`);
      console.log(`  ✗ ${progress} StopOfRoute 批次失敗：${error.message}`);
    }

    const shapeCount = Object.values(shapes).filter((entry) => entry.geometry).length;
    const stopCount = Object.keys(stops).length;
    const elapsed = (Date.now() - startedAt) / 1000;
    const eta = (elapsed / (index + 1)) * (batches.length - index - 1);
    console.log(
      `${progress} 線型 ${shapeCount} 筆、站牌 ${stopCount} 筆` +
        (index < batches.length - 1 ? `（預估剩餘 ${Math.ceil(eta / 60)} 分鐘）` : ""),
    );
  }

  // 補 null 給 TDX 沒有回傳 Shape 的路線（明確記錄「無可用線型」）
  const missingShapeKeys = [];
  for (const key of expectedKeys) {
    if (!(key in shapes)) {
      shapes[key] = { geometry: null, updatedAt: null };
      missingShapeKeys.push(key);
    } else if (!shapes[key].geometry) {
      missingShapeKeys.push(key);
    }
  }

  if (expectedKeys.length && expectedKeys.every((key) => !shapes[key]?.geometry)) {
    throw new Error("TDX 沒有回傳任何可用線型；請檢查 RouteUID／SubRouteUID 對應，保留既有資料");
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const stopPoints = Object.values(stops).flat();
  const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const mapCenter = stopPoints.length ? { lat: median(stopPoints.map((point) => point.lat)),
    lon: median(stopPoints.map((point) => point.lon)) } : null;
  const meta = {
    city: CITY,
    mapCenter,
    prefetchedAt: new Date().toISOString(),
    routeCount: routes.length,
    uniqueRouteUIDCount: uniqueUIDs.length,
    shapeKeyCount: expectedKeys.length,
    shapeCount: expectedKeys.filter((key) => shapes[key]?.geometry).length,
    missingShapeKeys,
    stopKeyCount: Object.keys(stops).length,
    stopCount: Object.values(stops).reduce((sum, list) => sum + list.length, 0),
    warnings,
  };

  const write = (name, data) => {
    const file = path.join(DATA_DIR, name);
    fs.writeFileSync(file, JSON.stringify(data), "utf8");
    const size = (fs.statSync(file).size / 1024 / 1024).toFixed(2);
    console.log(`  寫入 ${path.relative(ROOT, file)}（${size} MB）`);
  };

  write("routes.json", routes);
  write("shapes.json", shapes);
  write("stops.json", stops);
  write("meta.json", meta);

  const seconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `\n完成：${meta.shapeCount}/${meta.shapeKeyCount} 筆有線型、` +
      `${meta.stopKeyCount} 筆有站牌、耗時 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`,
  );
  if (missingShapeKeys.length > 0) {
    console.log(`TDX 無線型資料 ${missingShapeKeys.length} 筆（App 會標示為「無可用線型資料」）：`);
    for (const key of missingShapeKeys.slice(0, 20)) console.log(`  - ${key}`);
    if (missingShapeKeys.length > 20) console.log(`  … 其餘 ${missingShapeKeys.length - 20} 筆`);
  }
  if (warnings.length > 0) {
    console.log(`\n警告 ${warnings.length} 筆：`);
    for (const warning of warnings) console.log(`  - ${warning}`);
  }
}

main().catch((error) => {
  console.error("\n預先下載失敗：", error.message);
  process.exit(1);
});
