import L from "leaflet";

import type { CoverageChunk } from "@/lib/geometry/coverage";

import { COVERED_COLOR, ROUTE_DIMMED_WEIGHT, ROUTE_SELECTED_WEIGHT, UNCOVERED_COLOR } from "./colors";

/** 依「已走過 / 未走過」將 Shape 繪製為綠/紅折線 */

export interface RouteLayerOptions {
  weight?: number;
  opacity?: number;
  /** false 時只畫未走過（紅色）路段 */
  showCovered?: boolean;
  popupHtml?: string;
  /** 路線數量多時傳入 Canvas renderer 以維持效能 */
  renderer?: L.Renderer;
  /** 數值越大，低縮放時簡化越多（Leaflet smoothFactor） */
  smoothFactor?: number;
}

export function createRouteLayers(
  chunks: CoverageChunk[],
  options: RouteLayerOptions = {},
): L.Polyline[] {
  const layers: L.Polyline[] = [];
  const showCovered = options.showCovered !== false;

  for (const chunk of chunks) {
    if (chunk.points.length < 2) continue;
    if (chunk.covered && !showCovered) continue;

    const latlngs = chunk.points.map(
      (point) => [point.lat, point.lon] as L.LatLngTuple,
    );

    const line = L.polyline(latlngs, {
      color: chunk.covered ? COVERED_COLOR : UNCOVERED_COLOR,
      weight: options.weight ?? ROUTE_SELECTED_WEIGHT,
      opacity: options.opacity ?? 0.85,
      lineJoin: "round",
      lineCap: "round",
      renderer: options.renderer,
      smoothFactor: options.smoothFactor ?? 1,
    });

    if (options.popupHtml) line.bindPopup(options.popupHtml);
    layers.push(line);
  }

  return layers;
}

export function selectedWeight(): number {
  return ROUTE_SELECTED_WEIGHT;
}

export function dimmedWeight(): number {
  return ROUTE_DIMMED_WEIGHT;
}
