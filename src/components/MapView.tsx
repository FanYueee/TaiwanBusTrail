"use client";

import L from "leaflet";
import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";

import {
  DEFAULT_ZOOM,
  OSM_ATTRIBUTION,
  OSM_TILE_URL,
  TAICHUNG_CENTER,
} from "@/lib/map/colors";
import { createRouteLayers } from "@/lib/map/routeRenderer";
import { createStopLayer } from "@/lib/map/stopRenderer";
import { buildNetworkIndex, lookupNetworkAt } from "@/lib/map/networkLayer";
import { COVERED_COLOR, UNCOVERED_COLOR } from "@/lib/map/colors";
import type { MapRouteData, NetworkChainData } from "@/components/types";
import { directionLabel } from "@/lib/types";

/** 超過此路線數量即啟用視窗裁切與 Canvas 渲染 */
const CULLING_THRESHOLD = 50;

interface MapViewProps {
  routes: MapRouteData[];
  /** 合併路網（全部路線模式）：以 multi-polyline 繪製，點擊查詢行經路線 */
  network: NetworkChainData[] | null;
  hideExploredChunks: boolean;
  /** 變更時自動縮放至選取路線範圍（例如切換路線/方向） */
  fitToken: string | null;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function routeBounds(route: MapRouteData): L.LatLngBounds {
  return L.latLngBounds(
    [route.bounds.south, route.bounds.west],
    [route.bounds.north, route.bounds.east],
  );
}

export default function MapView({
  routes,
  network,
  hideExploredChunks,
  fitToken,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const networkGroupRef = useRef<L.LayerGroup | null>(null);
  const canvasRendererRef = useRef<L.Canvas | null>(null);
  const lastFitTokenRef = useRef<string | null>(null);
  const visibleKeyRef = useRef<string>("");
  const [layerToken, setLayerToken] = useState(0);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    // 可用網址參數指定初始視角，例如 ?lat=24.1731&lon=120.6606&zoom=16
    const params = new URLSearchParams(window.location.search);
    const latParam = params.get("lat");
    const lonParam = params.get("lon");
    const zoomParam = params.get("zoom");
    const paramLat = latParam === null ? Number.NaN : Number(latParam);
    const paramLon = lonParam === null ? Number.NaN : Number(lonParam);
    const paramZoom = zoomParam === null ? Number.NaN : Number(zoomParam);
    const hasView = Number.isFinite(paramLat) && Number.isFinite(paramLon);
    const initialCenter: [number, number] = hasView ? [paramLat, paramLon] : TAICHUNG_CENTER;
    const initialZoom = Number.isFinite(paramZoom)
      ? Math.min(19, Math.max(3, paramZoom))
      : DEFAULT_ZOOM;

    const map = L.map(containerRef.current, {
      center: initialCenter,
      zoom: initialZoom,
      zoomControl: true,
    });

    L.tileLayer(OSM_TILE_URL, {
      maxZoom: 19,
      attribution: OSM_ATTRIBUTION,
    }).addTo(map);

    layerGroupRef.current = L.layerGroup().addTo(map);
    networkGroupRef.current = L.layerGroup().addTo(map);
    canvasRendererRef.current = L.canvas({ padding: 0.5 });
    mapRef.current = map;

    // 容器尺寸若在掛載後才確定，重新計算地圖尺寸
    const resizeObserver = new ResizeObserver(() => map.invalidateSize());
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
      networkGroupRef.current = null;
      canvasRendererRef.current = null;
    };
  }, []);

  // 合併路網：兩個 multi-polyline（紅/綠）＋ 點擊查詢行經路線
  useEffect(() => {
    const map = mapRef.current;
    const group = networkGroupRef.current;
    if (!map || !group) return;

    group.clearLayers();
    if (!network || network.length === 0) return;

    const renderer = canvasRendererRef.current ?? undefined;
    const coveredLines: L.LatLngExpression[][] = [];
    const uncoveredLines: L.LatLngExpression[][] = [];

    for (const chain of network) {
      if (hideExploredChunks && chain.covered) continue;
      const latlngs = chain.points.map(
        (point) => [point.lat, point.lon] as L.LatLngExpression,
      );
      (chain.covered ? coveredLines : uncoveredLines).push(latlngs);
    }

    const index = buildNetworkIndex(network);

    const addLayer = (lines: L.LatLngExpression[][], color: string) => {
      if (lines.length === 0) return;
      const layer = L.polyline(lines, {
        color,
        weight: 2.5,
        opacity: 0.55,
        renderer,
        // 只做次像素級的簡化：幾乎不影響外觀，也避免低縮放時線段出現缺口
        smoothFactor: 0.5,
        lineJoin: "round",
        lineCap: "round",
        interactive: true,
      });
      layer.on("click", (event: L.LeafletMouseEvent) => {
        const result = lookupNetworkAt({ lat: event.latlng.lat, lon: event.latlng.lng }, network, index);
        const title = result.covered ? "已走過路段" : "尚未走過路段";
        const body =
          result.names.length > 0
            ? `<br/>行經路線：${escapeHtml(result.names.join("、"))}${result.names.length >= 15 ? " …" : ""}`
            : "";
        L.popup()
          .setLatLng(event.latlng)
          .setContent(`<strong>${title}</strong>${body}`)
          .openOn(map);
      });
      layer.addTo(group);
    };

    addLayer(coveredLines, COVERED_COLOR);
    addLayer(uncoveredLines, UNCOVERED_COLOR);
  }, [network, hideExploredChunks]);

  // 視窗裁切：只有「可見路線集合」改變時才重畫圖層，單純拖曳/縮放不會重建
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const updateVisibleKey = () => {
      if (routes.length <= CULLING_THRESHOLD) {
        if (visibleKeyRef.current !== "all") {
          visibleKeyRef.current = "all";
          setLayerToken((token) => token + 1);
        }
        return;
      }
      const bounds = map.getBounds().pad(0.5);
      const key = routes
        .filter((route) => bounds.intersects(routeBounds(route)))
        .map((route) => route.routeKey)
        .join("|");
      if (key !== visibleKeyRef.current) {
        visibleKeyRef.current = key;
        setLayerToken((token) => token + 1);
      }
    };

    updateVisibleKey();
    map.on("moveend", updateVisibleKey);
    map.on("zoomend", updateVisibleKey);
    return () => {
      map.off("moveend", updateVisibleKey);
      map.off("zoomend", updateVisibleKey);
    };
  }, [routes]);

  // 繪製圖層
  useEffect(() => {
    const map = mapRef.current;
    const group = layerGroupRef.current;
    if (!map || !group) return;

    group.clearLayers();

    const culling = routes.length > CULLING_THRESHOLD;
    let visibleKeys: Set<string> | null = null;
    if (culling) {
      if (visibleKeyRef.current === "" || visibleKeyRef.current === "all") {
        const bounds = map.getBounds().pad(0.5);
        visibleKeys = new Set(
          routes
            .filter((route) => bounds.intersects(routeBounds(route)))
            .map((route) => route.routeKey),
        );
        visibleKeyRef.current = [...visibleKeys].join("|");
      } else {
        visibleKeys = new Set(visibleKeyRef.current.split("|"));
      }
    }

    // 路線數量多時改用 Canvas 渲染，避免大量 SVG 節點拖慢縮放/拖曳
    const renderer = culling ? (canvasRendererRef.current ?? undefined) : undefined;

    for (const route of routes) {
      if (visibleKeys && !visibleKeys.has(route.routeKey)) continue;

      const popupHtml =
        route.popupTitle !== undefined
          ? `<strong>${escapeHtml(route.popupTitle)}</strong>` +
            (route.popupLines ?? [])
              .map((line) => `<br/>${escapeHtml(line)}`)
              .join("")
          : `<strong>${escapeHtml(route.routeName)}</strong>（${directionLabel(
              route.direction,
            )}）`;

      const lineLayers = createRouteLayers(route.chunks, {
        showCovered: !hideExploredChunks,
        popupHtml,
        weight: route.weight,
        opacity: route.opacity,
        renderer,
        smoothFactor: route.smoothFactor,
      });

      for (const layer of lineLayers) {
        layer.addTo(group);
      }

      if (route.showStops) {
        for (const stop of route.stops) {
          const marker = createStopLayer(stop, {
            popupHtml: `<strong>${escapeHtml(stop.stopName)}</strong><br/>第 ${stop.sequence} 站`,
          });
          marker.addTo(group);
        }
      }
    }
  }, [routes, hideExploredChunks, layerToken]);

  // 縮放至選取路線（與圖層重建分開，避免選擇路線時重建全部圖層）
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitToken || fitToken === lastFitTokenRef.current) return;

    const selected = routes.find((route) => route.isSelected);
    if (!selected) return;

    if (selected.chunks.length > 0) {
      lastFitTokenRef.current = fitToken;
      map.fitBounds(routeBounds(selected), { padding: [30, 30], maxZoom: 15 });
      return;
    }

    if (selected.stops.length > 0) {
      lastFitTokenRef.current = fitToken;
      const stopBounds = L.latLngBounds(
        selected.stops.map((stop) => [stop.lat, stop.lon] as L.LatLngTuple),
      );
      map.fitBounds(stopBounds, { padding: [30, 30], maxZoom: 15 });
    }
  }, [fitToken, routes]);

  return <div ref={containerRef} className="map-container" />;
}
