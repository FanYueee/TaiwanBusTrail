/**
 * 應用程式網域型別（與 TDX 原始格式解耦）
 */

export type Direction = 0 | 1;

export interface LatLon {
  lat: number;
  lon: number;
}

/** 一條公車路線的某個方向（TDX SubRoute 攤平後） */
export interface BusRoute {
  routeUID: string;
  routeID: string;
  routeName: string;
  /** 若與 routeName 不同（例如「300繞」），保留變體名稱供搜尋 */
  subRouteName: string | null;
  direction: Direction;
  departureStop: string;
  destinationStop: string;
  headsign: string;
  /** 營運業者（TDX Operators），用於業者篩選 */
  operatorIDs: string[];
  operatorNames: string[];
}

export interface BusStop {
  stopUID: string;
  stopName: string;
  lat: number;
  lon: number;
  /** TDX StopSequence，1 起算，沿行駛方向遞增 */
  sequence: number;
}

export interface BusShape {
  routeUID: string;
  direction: Direction;
  /** 實際道路線型（WKT LINESTRING 解析後），依行駛方向排序 */
  geometry: LatLon[];
  /** TDX 資料更新時間（非本地快取時間） */
  updatedAt: string | null;
}

/** 一筆搭乘紀錄，geometry 為使用者實際走過的路段幾何 */
export interface RideRecord {
  id: string;
  routeUID: string;
  routeID: string;
  routeName: string;
  direction: Direction;
  fromStopUID: string | null;
  toStopUID: string | null;
  fromStopName: string | null;
  toStopName: string | null;
  fullRoute: boolean;
  geometry: LatLon[];
  createdAt: string;
}

export interface AppSettings {
  onlyShowSelectedRoute: boolean;
  hideExploredSegments: boolean;
  /** 幾何比對容差（公尺），用於判斷兩條路線是否走在同一條道路上 */
  coverageToleranceMeters: number;
  /** 「顯示全部路線」時要顯示的方向（雙向路徑常幾乎重疊） */
  directionFilter: DirectionFilter;
  /** 是否顯示黃X（小黃公車）路線 */
  showHuangRoutes: boolean;
  /** 業者篩選；"all" 表示全部 */
  operatorFilter: string;
  /** 全部路線總覽時，將同一條道路上的多條路線合併為一條路網繪製 */
  mergeOverlappingRoutes: boolean;
  /** 左側控制區是否收合 */
  panelCollapsed: boolean;
}

/** 全部路線總覽的方向篩選；單向路線會自動保留（不會因篩選而消失） */
export type DirectionFilter = "outbound" | "inbound" | "both";

export const DEFAULT_SETTINGS: AppSettings = {
  onlyShowSelectedRoute: true,
  hideExploredSegments: false,
  coverageToleranceMeters: 25,
  directionFilter: "outbound",
  showHuangRoutes: false,
  operatorFilter: "all",
  mergeOverlappingRoutes: true,
  panelCollapsed: false,
};

/** 小黃公車路線名稱開頭 */
export const HUANG_ROUTE_PREFIX = "黃";

export function isHuangRoute(routeName: string): boolean {
  return routeName.startsWith(HUANG_ROUTE_PREFIX);
}

export const SETTINGS_LIMITS = {
  minToleranceMeters: 5,
  maxToleranceMeters: 60,
};

export function routeKey(routeUID: string, direction: Direction): string {
  return `${routeUID}:${direction}`;
}

export function directionLabel(direction: Direction): string {
  return direction === 0 ? "去程" : "返程";
}

export function fullRouteName(route: Pick<BusRoute, "routeName" | "subRouteName">): string {
  if (route.subRouteName && route.subRouteName !== route.routeName) {
    return `${route.routeName}（${route.subRouteName}）`;
  }
  return route.routeName;
}
