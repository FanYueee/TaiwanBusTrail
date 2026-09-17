import type { TdxStatus } from "@/lib/tdx/apiClient";
import type { CoverageChunk } from "@/lib/geometry/coverage";
import type { AppSettings, BusRoute, BusShape, BusStop, Direction, LatLon } from "@/lib/types";

export interface LoadedRoute {
  route: BusRoute;
  shape: BusShape | null;
  shapeMissing: boolean;
  stops: BusStop[];
  loading: boolean;
  error: string | null;
}

export interface PanelMessage {
  kind: "info" | "success" | "error";
  text: string;
}

export interface RouteBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface MapRouteData {
  routeKey: string;
  routeName: string;
  direction: Direction;
  chunks: CoverageChunk[];
  stops: BusStop[];
  isSelected: boolean;
  showStops: boolean;
  weight: number;
  opacity: number;
  smoothFactor: number;
  bounds: RouteBounds;
  /** 合併路網的 popup 標題／內容（單一路線模式不使用） */
  popupTitle?: string;
  popupLines?: string[];
  /** 該路段行經的路線數 */
  corridorSize?: number;
}

export interface AllRoutesState {
  loading: boolean;
  computing: boolean;
  error: string | null;
}

export interface NetworkChainData {
  points: LatLon[];
  covered: boolean;
  routeNames: string[];
}

export interface SliceInfo {
  fromName: string;
  toName: string;
  stationCount: number;
  distanceMeters: number;
}

export type { TdxStatus, AppSettings, BusRoute, BusShape, BusStop, Direction };
