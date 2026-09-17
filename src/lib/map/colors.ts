/** 地圖顏色定義：紅色＝尚未走過、綠色＝已走過 */

export const COVERED_COLOR = "#16a34a";
export const UNCOVERED_COLOR = "#dc2626";
export const STOP_COLOR = "#1d4ed8";
export const STOP_BORDER_COLOR = "#ffffff";
export const ROUTE_SELECTED_WEIGHT = 6;
export const ROUTE_DIMMED_WEIGHT = 4;

export const LEGEND_ITEMS = [
  { color: UNCOVERED_COLOR, label: "尚未走過" },
  { color: COVERED_COLOR, label: "已走過" },
] as const;

export const TAICHUNG_CENTER: [number, number] = [24.1477, 120.6736];
export const DEFAULT_ZOOM = 12;
export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
