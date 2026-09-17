import { getDb, type LocalMeta } from "./db";

import { DEFAULT_SETTINGS, type AppSettings } from "@/lib/types";

/** 本地設定與中繼資料（TDX 上次更新時間） */

const SETTINGS_KEY = "settings";
const META_KEY = "meta";

/** 舊版預設容差；若使用者從未調整過，升級為新版預設值（方向感知比對可承受更大容差） */
const LEGACY_DEFAULT_TOLERANCE_METERS = 15;

export async function loadSettings(): Promise<AppSettings> {
  const row = await getDb().settings.get(SETTINGS_KEY);
  const stored = { ...((row?.value ?? {}) as Partial<AppSettings>) };
  if (stored.coverageToleranceMeters === LEGACY_DEFAULT_TOLERANCE_METERS) {
    stored.coverageToleranceMeters = DEFAULT_SETTINGS.coverageToleranceMeters;
  }
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await getDb().settings.put({ key: SETTINGS_KEY, value: settings });
}

export async function loadMeta(): Promise<LocalMeta> {
  const row = await getDb().settings.get(META_KEY);
  const stored = (row?.value ?? {}) as Partial<LocalMeta>;
  return { tdxLastUpdated: stored.tdxLastUpdated ?? null };
}

export async function saveMeta(meta: LocalMeta): Promise<void> {
  await getDb().settings.put({ key: META_KEY, value: meta });
}
