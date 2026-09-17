import L from "leaflet";

import type { BusStop } from "@/lib/types";

import { STOP_BORDER_COLOR, STOP_COLOR } from "./colors";

/** 站牌繪製：藍色圓點 + 懸浮站名 */

export interface StopLayerOptions {
  highlighted?: boolean;
  popupHtml?: string;
}

export function createStopLayer(
  stop: BusStop,
  options: StopLayerOptions = {},
): L.CircleMarker {
  const marker = L.circleMarker([stop.lat, stop.lon], {
    radius: options.highlighted ? 6.5 : 4,
    color: STOP_BORDER_COLOR,
    weight: 1.5,
    fillColor: STOP_COLOR,
    fillOpacity: 1,
  });

  if (options.popupHtml) marker.bindPopup(options.popupHtml);
  marker.bindTooltip(`${stop.sequence}. ${stop.stopName}`, {
    direction: "top",
    offset: [0, -6],
  });

  return marker;
}
