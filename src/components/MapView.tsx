"use client";

import L from "leaflet";
import { maplibreGL } from "@maplibre/maplibre-gl-leaflet";
import { setWorkerUrl, type StyleSpecification } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import "maplibre-gl/dist/maplibre-gl.css";

import {
  DEFAULT_ZOOM,
  OSM_ATTRIBUTION,
  OSM_TILE_URL,
  TAICHUNG_CENTER,
  VECTOR_ATTRIBUTION,
  VECTOR_STYLE_URL,
} from "@/lib/map/colors";
import { createRouteLayers } from "@/lib/map/routeRenderer";
import { createStopLayer } from "@/lib/map/stopRenderer";
import { buildNetworkIndex, lookupNetworkAt } from "@/lib/map/networkLayer";
import { COVERED_COLOR, UNCOVERED_COLOR } from "@/lib/map/colors";
import { splitAtGradeCrossings } from "@/lib/map/overpassGaps";
import { metricCellCoordinates } from "@/lib/geometry/spatialIndex";
import { pathLengthMeters } from "@/lib/geometry/distance";
import type { MapRouteData, NetworkChainData } from "@/components/types";
import { directionLabel } from "@/lib/types";

/** 超過此路線數量即啟用視窗裁切與 Canvas 渲染 */
const CULLING_THRESHOLD = 50;

interface MapViewProps {
  initialCenter?: { lat: number; lon: number };
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

function adaptMapStyle(style: StyleSpecification): StyleSpecification {
  for (const layer of style.layers) {
    if (layer.type === "line" && /^(road_|bridge_|tunnel_)/.test(layer.id)) {
      const color = layer.paint?.["line-color"];
      if (color === "#fff" || color === "#ffffff" || color === "hsl(0,0%,100%)") {
        layer.paint = { ...layer.paint, "line-color": "#cbd5d1" };
      } else if (color === "#fea" || color === "#fff4c6") {
        layer.paint = { ...layer.paint, "line-color": "#e8c983" };
      }
    }
    if (layer.type === "symbol" && layer.layout?.["text-field"] && !/shield/.test(layer.id)) {
      layer.layout = {
        ...layer.layout,
        "text-field": ["coalesce", ["get", "name:zh"], ["get", "name:nonlatin"], ["get", "name"], ["get", "name:latin"]],
      };
    }
  }
  return style;
}

export default function MapView({
  initialCenter: datasetCenter,
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
  const [networkViewToken, setNetworkViewToken] = useState(0);
  const networkBounds = useMemo(() => network?.map((chain) => L.latLngBounds(
    chain.points.map((point) => [point.lat, point.lon] as [number, number]),
  )) ?? [], [network]);

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
    const initialCenter: [number, number] = hasView ? [paramLat, paramLon]
      : datasetCenter ? [datasetCenter.lat, datasetCenter.lon] : TAICHUNG_CENTER;
    const initialZoom = Number.isFinite(paramZoom)
      ? Math.min(19, Math.max(3, paramZoom))
      : DEFAULT_ZOOM;

    const map = L.map(containerRef.current, {
      center: initialCenter,
      zoom: initialZoom,
      zoomControl: true,
    });

    const controller = new AbortController();
    let loadTimeout: number | undefined;
    let readyTimeout: number | undefined;
    let retryTimeout: number | undefined;
    let removeVector: (() => void) | undefined;
    let resizeVector: (() => void) | undefined;
    const fallback = () => {
      const tiles = L.tileLayer(OSM_TILE_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(map);
      tiles.once("load", () => {
        if (containerRef.current) containerRef.current.dataset.basemapReady = "true";
      });
    };
    const loadVector = (attempt: number) => {
      const retry = (error?: unknown) => {
        if (controller.signal.aborted) return;
        if (containerRef.current) containerRef.current.dataset.basemapReady = "false";
        if (attempt < 2) {
          retryTimeout = window.setTimeout(() => loadVector(attempt + 1), 1000 * (attempt + 1));
        } else {
          console.error("Vector basemap failed; using raster fallback", error);
          fallback();
        }
      };
      void fetch(VECTOR_STYLE_URL, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`Map style HTTP ${response.status}`);
          return response.json() as Promise<StyleSpecification>;
        })
        .then((style) => {
          if (controller.signal.aborted) return;
          setWorkerUrl("/vendor/maplibre-gl-worker.mjs");
          const layer = maplibreGL({ style: adaptMapStyle(style), attributionControl: false }).addTo(map);
          map.attributionControl?.addAttribution(VECTOR_ATTRIBUTION);
          const vectorMap = layer.getMaplibreMap();
          let active = true;
          const resize = () => vectorMap.resize();
          resizeVector = resize;
          const remove = () => {
            if (!active) return;
            active = false;
            if (loadTimeout !== undefined) window.clearTimeout(loadTimeout);
            if (readyTimeout !== undefined) window.clearTimeout(readyTimeout);
            vectorMap.off("idle", onIdle);
            vectorMap.off("sourcedataloading", onSourceLoading);
            vectorMap.off("error", onError);
            if (resizeVector === resize) resizeVector = undefined;
            if (map.hasLayer(layer)) map.removeLayer(layer);
            map.attributionControl?.removeAttribution(VECTOR_ATTRIBUTION);
          };
          const fail = (error: unknown) => {
            if (!active) return;
            remove();
            retry(error);
          };
          const armTimeout = () => {
            if (loadTimeout !== undefined) window.clearTimeout(loadTimeout);
            loadTimeout = window.setTimeout(() => fail(new Error("Vector tile load timed out")), 15000);
          };
          const onIdle = () => {
            if (!active || !vectorMap.areTilesLoaded()) return;
            if (loadTimeout !== undefined) window.clearTimeout(loadTimeout);
            if (readyTimeout !== undefined) window.clearTimeout(readyTimeout);
            readyTimeout = window.setTimeout(() => {
              if (active && vectorMap.areTilesLoaded() && containerRef.current) {
                containerRef.current.dataset.basemapReady = "true";
              }
            }, 700);
          };
          const onSourceLoading = (event: { sourceId?: string }) => {
            if (!active || event.sourceId !== "openmaptiles") return;
            if (readyTimeout !== undefined) window.clearTimeout(readyTimeout);
            if (containerRef.current) containerRef.current.dataset.basemapReady = "false";
            armTimeout();
          };
          const onError = (event: { error: unknown; tile?: unknown; sourceId?: string }) => {
            if (event.tile || event.sourceId === "openmaptiles") fail(event.error);
          };
          vectorMap.on("idle", onIdle);
          vectorMap.on("sourcedataloading", onSourceLoading);
          vectorMap.on("error", onError);
          removeVector = remove;
          armTimeout();
        })
        .catch(retry);
    };
    loadVector(0);
    containerRef.current.dataset.zoom = String(map.getZoom());
    map.on("zoomend", () => {
      if (containerRef.current) containerRef.current.dataset.zoom = String(map.getZoom());
    });

    layerGroupRef.current = L.layerGroup().addTo(map);
    networkGroupRef.current = L.layerGroup().addTo(map);
    canvasRendererRef.current = L.canvas({ padding: 0.5 });
    mapRef.current = map;

    // 容器尺寸若在掛載後才確定，重新計算地圖尺寸
    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current) containerRef.current.dataset.basemapReady = "false";
      map.invalidateSize();
      window.requestAnimationFrame(() => {
        if (!controller.signal.aborted) resizeVector?.();
      });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      controller.abort();
      if (loadTimeout !== undefined) window.clearTimeout(loadTimeout);
      if (readyTimeout !== undefined) window.clearTimeout(readyTimeout);
      if (retryTimeout !== undefined) window.clearTimeout(retryTimeout);
      removeVector?.();
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
      networkGroupRef.current = null;
      canvasRendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const update = () => setNetworkViewToken((value) => value + 1);
    map.on("moveend", update);
    return () => { map.off("moveend", update); };
  }, []);

  // 按高程分組的共用 multi-polyline，不逐公車建圖層。
  useEffect(() => {
    const map = mapRef.current;
    const group = networkGroupRef.current;
    if (!map || !group) return;

    group.clearLayers();
    if (!network || network.length === 0) return;

    const renderer = canvasRendererRef.current ?? undefined;
    const grades = new Map<number, {
      covered: L.LatLngExpression[][]; uncovered: L.LatLngExpression[][];
      quietCovered: L.LatLngExpression[][]; quietUncovered: L.LatLngExpression[][];
      rampCovered: L.LatLngExpression[][]; rampUncovered: L.LatLngExpression[][];
    }>();

    const viewport = map.getBounds().pad(0.3);
    const visibleNetwork = network.filter((chain, index) =>
      !(hideExploredChunks && chain.covered) && viewport.intersects(networkBounds[index]),
    );
    const densityCell = (chain: NetworkChainData) => {
      const point = chain.points[Math.floor(chain.points.length / 2)];
      const cell = metricCellCoordinates(point, 125);
      return `${cell.cx},${cell.cy}`;
    };
    const density = new Map<string, number>();
    if (map.getZoom() >= 17) for (const chain of visibleNetwork) {
      const cell = densityCell(chain);
      density.set(cell, (density.get(cell) ?? 0) + 1);
    }
    const displayLines = map.getZoom() >= 16
      ? splitAtGradeCrossings(visibleNetwork, (point) => map.project([point.lat, point.lon], map.getZoom()))
      : visibleNetwork.map((chain) => [chain.points]);
    for (const [index, chain] of visibleNetwork.entries()) {
      if (hideExploredChunks && chain.covered) continue;
      const parsed = Number(chain.level?.split("|")[0] ?? 0);
      const grade = Number.isFinite(parsed) ? parsed : 0;
      const lines = grades.get(grade) ?? { covered: [], uncovered: [], quietCovered: [], quietUncovered: [], rampCovered: [], rampUncovered: [] };
      const quiet = !chain.fastRoad && (density.get(densityCell(chain)) ?? 0) >= 35
        && chain.routeNames.length <= 3 && pathLengthMeters(chain.points) <= 100;
      for (const piece of displayLines[index]) {
        (quiet ? chain.covered ? lines.quietCovered : lines.quietUncovered
          : chain.ramp ? chain.covered ? lines.rampCovered : lines.rampUncovered
          : chain.covered ? lines.covered : lines.uncovered).push(piece.map(
          (point) => [point.lat, point.lon] as L.LatLngExpression,
        ));
      }
      grades.set(grade, lines);
    }

    const index = buildNetworkIndex(visibleNetwork);

    const addLayer = (lines: L.LatLngExpression[][], color: string, style: "quiet" | "ramp" | "normal" = "normal") => {
      if (lines.length === 0) return;
      const layer = L.polyline(lines, {
        color,
        weight: style === "quiet" ? 1.3 : style === "ramp" ? map.getZoom() >= 18 ? 1.6 : 2.1
          : map.getZoom() >= 18 ? 2.25 : map.getZoom() >= 16 ? 2.8 : 3.5,
        opacity: style === "quiet" ? 0.4 : style === "ramp" ? 0.7 : 0.95,
        renderer,
        // 只做次像素級的簡化：幾乎不影響外觀，也避免低縮放時線段出現缺口
        smoothFactor: 0.5,
        lineJoin: "round",
        lineCap: "round",
        interactive: true,
      });
      layer.on("click", (event: L.LeafletMouseEvent) => {
        const result = lookupNetworkAt({ lat: event.latlng.lat, lon: event.latlng.lng }, visibleNetwork, index);
        const title = result.mixed ? "交會路口（部分路段已走過）" : result.covered ? "已走過路段" : "尚未走過路段";
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

    for (const [, lines] of [...grades].sort(([a], [b]) => a - b)) {
      addLayer(lines.quietUncovered, UNCOVERED_COLOR, "quiet");
      addLayer(lines.quietCovered, COVERED_COLOR, "quiet");
      addLayer(lines.rampUncovered, UNCOVERED_COLOR, "ramp");
      addLayer(lines.rampCovered, COVERED_COLOR, "ramp");
      addLayer(lines.uncovered, UNCOVERED_COLOR);
      // Blue branch end caps must not punch tiny holes in a ridden through road.
      addLayer(lines.covered, COVERED_COLOR);
    }
  }, [network, networkBounds, networkViewToken, hideExploredChunks]);

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
