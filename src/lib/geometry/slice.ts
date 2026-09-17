import type { BusStop, LatLon } from "@/lib/types";

import {
  cumulativeLengths,
  projectPointOnPolyline,
  slicePolylineByDistance,
  type PolylineProjection,
} from "./distance";

/**
 * Shape 區間切割
 *
 * 依上車站 / 下車站的 StopUID 從官方 Shape 切出兩站之間的實際道路區段。
 * 一律以 Shape 的行駛方向（起點→終點）回傳，與使用者選取順序無關，
 * 因為「是否走過某條道路」與行駛方向無關。
 */

export interface ShapeSlice {
  points: LatLon[];
  fromStop: BusStop;
  toStop: BusStop;
  fromProjection: PolylineProjection;
  toProjection: PolylineProjection;
}

export function sliceShapeBetweenStops(
  shape: LatLon[],
  stops: BusStop[],
  fromStopUID: string,
  toStopUID: string,
): ShapeSlice | null {
  if (shape.length < 2) return null;

  const fromStop = stops.find((stop) => stop.stopUID === fromStopUID);
  const toStop = stops.find((stop) => stop.stopUID === toStopUID);
  if (!fromStop || !toStop) return null;

  const fromProjection = projectPointOnPolyline(
    { lat: fromStop.lat, lon: fromStop.lon },
    shape,
  );
  const toProjection = projectPointOnPolyline({ lat: toStop.lat, lon: toStop.lon }, shape);
  if (!fromProjection || !toProjection) return null;

  const cumulative = cumulativeLengths(shape);
  const points = slicePolylineByDistance(
    shape,
    cumulative,
    fromProjection.alongMeters,
    toProjection.alongMeters,
  );
  if (points.length < 2) return null;

  return { points, fromStop, toStop, fromProjection, toProjection };
}

/** 計算站牌投影到 Shape 的距離，可用於偵測站牌與線型明顯不符的路線 */
export function maxStopSnapDistance(
  shape: LatLon[],
  stops: BusStop[],
): number {
  let max = 0;
  for (const stop of stops) {
    const projection = projectPointOnPolyline({ lat: stop.lat, lon: stop.lon }, shape);
    if (projection) max = Math.max(max, projection.distanceMeters);
  }
  return max;
}
