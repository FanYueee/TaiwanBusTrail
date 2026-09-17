/**
 * TDX v2 Bus API 原始回應型別（僅列出本專案使用的欄位）
 *
 * 實際結構已由 `scripts/verify-tdx.mjs` 對台中市資料驗證，
 * 詳見 docs/tdx-verification.md。
 */

export interface TdxName {
  Zh_tw?: string;
  En?: string;
}

export interface TdxOperator {
  OperatorID?: string;
  OperatorName?: TdxName;
}

export interface TdxSubRoute {
  SubRouteUID?: string;
  SubRouteID?: string;
  SubRouteName?: TdxName;
  Direction?: number;
  Headsign?: string;
}

export interface TdxRoute {
  RouteUID?: string;
  RouteID?: string;
  RouteName?: TdxName;
  DepartureStopNameZh?: string;
  DestinationStopNameZh?: string;
  SubRoutes?: TdxSubRoute[];
  Operators?: TdxOperator[];
  UpdateTime?: string;
}

export interface TdxShape {
  RouteUID?: string;
  RouteID?: string;
  Direction?: number;
  Geometry?: string | number[][] | null;
  EncodedPolyline?: string | null;
  UpdateTime?: string;
}

export interface TdxStopPosition {
  PositionLat?: number;
  PositionLon?: number;
}

export interface TdxStop {
  StopUID?: string;
  StopName?: TdxName;
  StopSequence?: number;
  StopPosition?: TdxStopPosition;
}

export interface TdxStopOfRoute {
  RouteUID?: string;
  Direction?: number;
  Stops?: TdxStop[];
  UpdateTime?: string;
}

export interface TdxApiError {
  error: string;
}
