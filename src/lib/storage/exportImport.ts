import { getAllRideRecords, replaceAllRideRecords } from "./rideRecords";
import { loadSettings, saveSettings } from "./settings";

import { DEFAULT_SETTINGS, type AppSettings, type LatLon, type RideRecord } from "@/lib/types";

/**
 * 個人資料匯出 / 匯入
 *
 * 只包含搭乘紀錄與設定；OSM/TDX 圖資不快取於匯出檔中。
 */

export const EXPORT_APP_ID = "taichung-bus-coverage-map";
export const EXPORT_VERSION = 1;

export interface ExportBundle {
  app: string;
  version: number;
  exportedAt: string;
  rideRecords: RideRecord[];
  settings: AppSettings;
}

export async function buildExportBundle(): Promise<ExportBundle> {
  const [rideRecords, settings] = await Promise.all([
    getAllRideRecords(),
    loadSettings(),
  ]);
  return {
    app: EXPORT_APP_ID,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    rideRecords,
    settings,
  };
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function isValidLatLon(value: unknown): value is LatLon {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isFinite((value as LatLon).lat) &&
    Number.isFinite((value as LatLon).lon)
  );
}

function sanitizeRideRecord(raw: unknown): RideRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Partial<RideRecord>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (typeof record.routeUID !== "string" || record.routeUID.length === 0) return null;
  if (record.direction !== 0 && record.direction !== 1) return null;
  if (!Array.isArray(record.geometry) || record.geometry.length < 2) return null;
  if (!record.geometry.every(isValidLatLon)) return null;

  return {
    id: record.id,
    routeUID: record.routeUID,
    routeID: typeof record.routeID === "string" ? record.routeID : "",
    routeName: typeof record.routeName === "string" ? record.routeName : record.routeUID,
    direction: record.direction,
    fromStopUID: record.fromStopUID ?? null,
    toStopUID: record.toStopUID ?? null,
    fromStopName: record.fromStopName ?? null,
    toStopName: record.toStopName ?? null,
    fullRoute: Boolean(record.fullRoute),
    geometry: record.geometry,
    createdAt:
      typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
  };
}

export function parseImportBundle(text: string): ExportBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("匯入失敗：檔案不是有效的 JSON");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("匯入失敗：檔案格式不正確");
  }

  const bundle = parsed as Partial<ExportBundle>;
  if (bundle.app !== EXPORT_APP_ID) {
    throw new Error("匯入失敗：這不是本專案匯出的個人資料檔");
  }
  if (!Array.isArray(bundle.rideRecords)) {
    throw new Error("匯入失敗：缺少 rideRecords");
  }

  const rideRecords: RideRecord[] = [];
  for (const raw of bundle.rideRecords) {
    const record = sanitizeRideRecord(raw);
    if (!record) throw new Error("匯入失敗：搭乘紀錄格式不正確");
    rideRecords.push(record);
  }

  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...(typeof bundle.settings === "object" && bundle.settings !== null
      ? (bundle.settings as Partial<AppSettings>)
      : {}),
  };

  return {
    app: EXPORT_APP_ID,
    version: typeof bundle.version === "number" ? bundle.version : EXPORT_VERSION,
    exportedAt:
      typeof bundle.exportedAt === "string" ? bundle.exportedAt : new Date().toISOString(),
    rideRecords,
    settings,
  };
}

export async function applyImportBundle(bundle: ExportBundle): Promise<void> {
  await replaceAllRideRecords(bundle.rideRecords);
  await saveSettings(bundle.settings);
}
