import Dexie, { type Table } from "dexie";

import type {
  AppSettings,
  BusRoute,
  BusStop,
  Direction,
  LatLon,
  RideRecord,
} from "@/lib/types";

/**
 * 本地 IndexedDB（Dexie）
 *
 * 所有資料只存在使用者瀏覽器，不會上傳到任何伺服器。
 * 分兩類：
 *   - 個人資料：rideRecords、settings（匯出/匯入的對象）
 *   - TDX 圖資快取：routes、shapes、stops（可被「更新公車資料」清除重建）
 */

export interface CachedRoutesRow {
  city: string;
  routes: BusRoute[];
  fetchedAt: string;
}

export interface CachedShapeRow {
  key: string;
  routeUID: string;
  direction: Direction;
  /** null 表示 TDX 無可用線型資料（不以站牌直線代替） */
  geometry: LatLon[] | null;
  updatedAt: string | null;
  fetchedAt: string;
}

export interface CachedStopsRow {
  key: string;
  routeUID: string;
  direction: Direction;
  stops: BusStop[];
  fetchedAt: string;
}

export interface SettingsRow {
  key: string;
  value: AppSettings | LocalMeta | unknown;
}

export interface LocalMeta {
  tdxLastUpdated: string | null;
}

export class TcbusDatabase extends Dexie {
  routes!: Table<CachedRoutesRow, string>;
  shapes!: Table<CachedShapeRow, string>;
  stops!: Table<CachedStopsRow, string>;
  rideRecords!: Table<RideRecord, string>;
  settings!: Table<SettingsRow, string>;

  constructor() {
    super("taichung-bus-coverage-map");
    this.version(1).stores({
      routes: "city",
      shapes: "key, routeUID, direction",
      stops: "key, routeUID, direction",
      rideRecords: "id, routeUID, direction, createdAt",
      settings: "key",
    });
  }
}

let database: TcbusDatabase | null = null;

/** 只在瀏覽器端呼叫；延後建立避免 SSR 階段碰到 indexedDB */
export function getDb(): TcbusDatabase {
  if (!database) database = new TcbusDatabase();
  return database;
}
