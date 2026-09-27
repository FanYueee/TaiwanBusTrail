"use client";

import { computeNetworkCoverage } from "@/lib/geometry/networkCoverage";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import ControlPanel from "./ControlPanel";
import type {
  AllRoutesState,
  LoadedRoute,
  MapRouteData,
  NetworkChainData,
  PanelMessage,
  SliceInfo,
  TdxStatus,
} from "./types";

import {
  buildExploredIndex,
  computeCoverage,
  createToleranceMatcher,
  pathLengthMeters,
  sliceShapeBetweenStops,
  type CoverageChunk,
  type RoadNetworkChain,
} from "@/lib/geometry";
import { loadAllTdxData, type AllTdxData } from "@/lib/tdx/allRoutes";
import { unpackNetwork, type PackedNetwork } from "@/lib/geometry/networkFormat";
import { fetchTdxJson, fetchTdxStatus } from "@/lib/tdx/apiClient";
import { loadRoutes } from "@/lib/tdx/routes";
import { loadShape } from "@/lib/tdx/shapes";
import { loadStops } from "@/lib/tdx/stops";
import {
  applyImportBundle,
  buildExportBundle,
  downloadJson,
  parseImportBundle,
} from "@/lib/storage/exportImport";
import {
  addRideRecord,
  clearRideRecords,
  createRideRecordId,
  deleteRideRecord,
  deleteRideRecords,
  findRideRecords,
  getAllRideRecords,
} from "@/lib/storage/rideRecords";
import { loadMeta, loadSettings, saveMeta, saveSettings } from "@/lib/storage/settings";
import { clearTdxCache } from "@/lib/storage/tdxCache";
import {
  DEFAULT_SETTINGS,
  directionLabel,
  fullRouteName,
  isHuangRoute,
  routeKey,
  type AppSettings,
  type BusRoute,
  type Direction,
  type RideRecord,
} from "@/lib/types";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => <div className="map-loading">地圖載入中…</div>,
});

/** 計算 chunks 的經緯度範圍，供地圖視窗裁切使用 */
function boundsOfChunks(chunks: CoverageChunk[]): MapRouteData["bounds"] {
  let south = 90;
  let west = 180;
  let north = -90;
  let east = -180;

  for (const chunk of chunks) {
    for (const point of chunk.points) {
      if (point.lat < south) south = point.lat;
      if (point.lat > north) north = point.lat;
      if (point.lon < west) west = point.lon;
      if (point.lon > east) east = point.lon;
    }
  }

  if (south > north) return { south: 0, west: 0, north: 0, east: 0 };
  return { south, west, north, east };
}

function routeTypeVisible(route: BusRoute, settings: AppSettings): boolean {
  const name = route.routeName;
  return (settings.showHuangRoutes || !isHuangRoute(name)) &&
    (settings.showCitizenMinibusRoutes || !name.startsWith("市民小巴")) &&
    (settings.showZidaRoutes || !name.startsWith("自達")) &&
    (settings.showLishanRoutes || !name.startsWith("梨山"));
}

export default function AppShell() {
  const [tdxStatus, setTdxStatus] = useState<TdxStatus | null>(null);
  const [routeList, setRouteList] = useState<BusRoute[]>([]);
  const [loadingRoutes, setLoadingRoutes] = useState(false);
  const [loadedRoutes, setLoadedRoutes] = useState<Record<string, LoadedRoute>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [fromStopUID, setFromStopUID] = useState("");
  const [toStopUID, setToStopUID] = useState("");
  const [rideRecords, setRideRecords] = useState<RideRecord[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [tdxLastUpdated, setTdxLastUpdated] = useState<string | null>(null);
  const [message, setMessage] = useState<PanelMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [fitToken, setFitToken] = useState<string | null>(null);
  const [allData, setAllData] = useState<AllTdxData | null>(null);
  const [allChunks, setAllChunks] = useState<Record<string, CoverageChunk[]> | null>(
    null,
  );
  const [allRoutesState, setAllRoutesState] = useState<AllRoutesState>({
    loading: false,
    computing: false,
    error: null,
  });
  const [allNetwork, setAllNetwork] = useState<RoadNetworkChain[] | null>(null);
  const [networkData, setNetworkData] = useState<{ routes: BusRoute[]; network: RoadNetworkChain[]; qualityNote: string; shapeHashes: Record<string, string> } | null>(null);

  const initialisedRef = useRef(false);
  const pendingForceRef = useRef(false);
  const ttlDays = tdxStatus?.cacheTtlDays ?? 7;
  const city = tdxStatus?.prefetch.city ?? undefined;

  /** 取消「只顯示目前選擇路線」時，直接進入全部路線總覽 */
  const showAllRoutes = !settings.onlyShowSelectedRoute;

  // ---------- 初始化：載入本機設定與紀錄 ----------

  useEffect(() => {
    if (initialisedRef.current) return;
    initialisedRef.current = true;

    void (async () => {
      try {
        const [status, storedSettings, meta, records] = await Promise.all([
          fetchTdxStatus(),
          loadSettings(),
          loadMeta(),
          getAllRideRecords(),
        ]);
        setTdxStatus(status);
        setSettings(storedSettings);
        setTdxLastUpdated(meta.tdxLastUpdated);
        setRideRecords(records);
        if (!status.prefetch.available) {
          setMessage({
            kind: "error",
            text: "尚未建立公車資料。請在專案目錄執行 npm run prefetch:tdx 後重新整理頁面。",
          });
        }
      } catch (error) {
        setMessage({ kind: "error", text: (error as Error).message });
      } finally {
        setSettingsReady(true);
      }
    })();
  }, []);

  // ---------- 路線清單 ----------

  const refreshRouteList = useCallback(
    async (force: boolean) => {
      setLoadingRoutes(true);
      try {
        const result = await loadRoutes({ ttlDays, force, city });
        setRouteList(result.routes);
        if (force) {
          const now = new Date().toISOString();
          await saveMeta({ tdxLastUpdated: now });
          setTdxLastUpdated(now);
        }
        return result;
      } finally {
        setLoadingRoutes(false);
      }
    },
    [ttlDays, city],
  );

  useEffect(() => {
    if (!tdxStatus?.prefetch.available) return;
    void refreshRouteList(false).catch((error) =>
      setMessage({ kind: "error", text: (error as Error).message }),
    );
  }, [tdxStatus?.prefetch.available, refreshRouteList]);

  // ---------- 選取路線：載入 Shape 與站牌 ----------

  const selectedRoute = useMemo(
    () => routeList.find((route) => routeKey(route.routeUID, route.direction) === selectedKey) ?? null,
    [routeList, selectedKey],
  );

  const ensureLoaded = useCallback(
    async (route: BusRoute, options?: { force?: boolean }) => {
      const key = routeKey(route.routeUID, route.direction);
      setLoadedRoutes((prev) => ({
        ...prev,
        [key]: {
          route,
          shape: prev[key]?.shape ?? null,
          shapeMissing: false,
          stops: prev[key]?.stops ?? [],
          loading: true,
          error: null,
        },
      }));

      try {
        const [shapeResult, stopsResult] = await Promise.all([
          loadShape(route.routeUID, route.direction, {
            ttlDays,
            force: options?.force,
          }),
          loadStops(route.routeUID, route.direction, {
            ttlDays,
            force: options?.force,
          }),
        ]);

        setLoadedRoutes((prev) => ({
          ...prev,
          [key]: {
            route,
            shape: shapeResult.shape,
            shapeMissing: shapeResult.shape === null,
            stops: stopsResult.stops,
            loading: false,
            error: null,
          },
        }));
      } catch (error) {
        setLoadedRoutes((prev) => ({
          ...prev,
          [key]: {
            route,
            shape: null,
            shapeMissing: false,
            stops: [],
            loading: false,
            error: (error as Error).message,
          },
        }));
      }
    },
    [ttlDays],
  );

  useEffect(() => {
    if (!selectedRoute) return;
    const key = routeKey(selectedRoute.routeUID, selectedRoute.direction);
    if (loadedRoutes[key]) return;
    const force = pendingForceRef.current;
    pendingForceRef.current = false;
    void ensureLoaded(selectedRoute, { force });
  }, [selectedRoute, loadedRoutes, ensureLoaded]);

  const availableDirections = useMemo(() => {
    if (!selectedRoute) return [];
    const seen = new Set<Direction>();
    return routeList
      .filter((route) => route.routeUID === selectedRoute.routeUID)
      .filter((route) => {
        if (seen.has(route.direction)) return false;
        seen.add(route.direction);
        return true;
      })
      .sort((a, b) => a.direction - b.direction);
  }, [routeList, selectedRoute]);

  const selectedLoaded = selectedKey ? loadedRoutes[selectedKey] : undefined;

  // 站牌載入後設定預設上下車站
  useEffect(() => {
    const stops = selectedLoaded?.stops ?? [];
    if (stops.length === 0) {
      setFromStopUID("");
      setToStopUID("");
      return;
    }
    setFromStopUID((prev) =>
      stops.some((stop) => stop.stopUID === prev) ? prev : stops[0].stopUID,
    );
    setToStopUID((prev) =>
      stops.some((stop) => stop.stopUID === prev)
        ? prev
        : stops[stops.length - 1].stopUID,
    );
  }, [selectedLoaded]);

  const handleSelectRoute = useCallback((route: BusRoute) => {
    const key = routeKey(route.routeUID, route.direction);
    setSelectedKey(key);
    setFitToken(`${key}:${Date.now()}`);
    setMessage(null);
  }, []);

  const handleSwitchDirection = useCallback(
    (direction: Direction) => {
      if (!selectedRoute) return;
      const target = routeList.find(
        (route) =>
          route.routeUID === selectedRoute.routeUID && route.direction === direction,
      );
      if (target) handleSelectRoute(target);
    },
    [routeList, selectedRoute, handleSelectRoute],
  );

  const handleRetryLoad = useCallback(() => {
    if (selectedRoute) void ensureLoaded(selectedRoute, { force: false });
  }, [selectedRoute, ensureLoaded]);

  // ---------- 已走過幾何 ----------

  const exploredIndex = useMemo(() => buildExploredIndex(rideRecords), [rideRecords]);
  const matcher = useMemo(
    () =>
      createToleranceMatcher(exploredIndex, {
        toleranceMeters: settings.coverageToleranceMeters,
      }),
    [exploredIndex, settings.coverageToleranceMeters],
  );

  const selectedSlice = useMemo(() => {
    if (!selectedLoaded?.shape || !fromStopUID || !toStopUID) return null;
    if (fromStopUID === toStopUID) return null;
    return sliceShapeBetweenStops(
      selectedLoaded.shape.geometry,
      selectedLoaded.stops,
      fromStopUID,
      toStopUID,
    );
  }, [selectedLoaded, fromStopUID, toStopUID]);

  const sliceInfo: SliceInfo | null = useMemo(() => {
    if (!selectedSlice) return null;
    return {
      fromName: selectedSlice.fromStop.stopName,
      toName: selectedSlice.toStop.stopName,
      stationCount:
        Math.abs(selectedSlice.toStop.sequence - selectedSlice.fromStop.sequence) + 1,
      distanceMeters: pathLengthMeters(selectedSlice.points),
    };
  }, [selectedSlice]);

  // ---------- 顯示全部路線（取消「只顯示目前選擇路線」時） ----------

  // 載入整包預先下載資料
  useEffect(() => {
    if (!showAllRoutes) return;
    if (settings.mergeOverlappingRoutes) return;
    if (tdxStatus === null) return;

    if (!tdxStatus.prefetch.available) {
      setAllRoutesState({
        loading: false,
        computing: false,
        error:
          "尚未預先下載全部線型，目前只顯示已載入的路線。請在專案目錄執行 npm run prefetch:tdx（約 8 分鐘）後重新整理。",
      });
      return;
    }

    if (allData || allRoutesState.loading) return;

    setAllRoutesState({ loading: true, computing: false, error: null });
    void (async () => {
      try {
        const data = await loadAllTdxData();
        setAllData(data);
        setAllRoutesState({
          loading: false,
          computing: true,
          error: null,
        });
      } catch (error) {
        setAllRoutesState({
          loading: false,
          computing: false,
          error: (error as Error).message,
        });
      }
    })();
  }, [showAllRoutes, settings.mergeOverlappingRoutes, allData, allRoutesState.loading, tdxStatus]);

  // 合併模式只下載共用路網，不下載全部路線的重複線型與站牌。
  useEffect(() => {
    if (!settings.mergeOverlappingRoutes || networkData || !tdxStatus?.prefetch.available) return;
    let cancelled = false;
    setAllRoutesState({ loading: true, computing: false, error: null });
    void fetchTdxJson<{ routes: BusRoute[]; network: PackedNetwork; reports: Record<string, { unmatched: number }>; shapeHashes: Record<string, string> }>("/api/tdx/network")
      .then((data) => {
        if (cancelled) return;
        const incomplete = Object.values(data.reports).filter((report) => report.unmatched > 0);
        const missing = incomplete.reduce((sum, report) => sum + report.unmatched, 0);
        setNetworkData({ routes: data.routes, network: unpackNetwork(data.network), shapeHashes: data.shapeHashes, qualityNote: missing
          ? `全市路網有 ${incomplete.length} 筆路線方向、${missing} 個取樣點無法連續匹配道路，未強行接線。可切換單一路線查看原始線型。`
          : "" });
        setAllRoutesState({ loading: false, computing: false, error: null });
      })
      .catch((error) => {
        if (!cancelled) setAllRoutesState({ loading: false, computing: false, error: error.message });
      });
    return () => { cancelled = true; };
  }, [showAllRoutes, settings.mergeOverlappingRoutes, networkData, tdxStatus]);

  // 計算全部路線的覆蓋狀態；切回單一路線模式時釋放記憶體
  useEffect(() => {
    if (settings.mergeOverlappingRoutes) return;
    if (!showAllRoutes) {
      setAllChunks((prev) => (prev === null ? prev : null));
      setAllRoutesState((prev) =>
        prev.error === null && !prev.computing && !prev.loading
          ? prev
          : { loading: false, computing: false, error: null },
      );
      return;
    }
    if (!allData) return;

    let cancelled = false;
    setAllRoutesState((prev) => ({ ...prev, computing: true, error: null }));

    void (async () => {
      // 先讓「計算中」訊息有機會顯示，再進行同步計算
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (cancelled) return;

      const spacing = Math.max(60, settings.coverageToleranceMeters);
      const routeKeys = new Set(
        allData.routes.map((route) => routeKey(route.routeUID, route.direction)),
      );
      const result: Record<string, CoverageChunk[]> = {};

      for (const [key, entry] of Object.entries(allData.shapes)) {
        if (!entry?.geometry || !routeKeys.has(key)) continue;
        result[key] = computeCoverage(entry.geometry, matcher, {
          sampleSpacingMeters: spacing,
        });
      }

      if (cancelled) return;
      setAllChunks(result);
      setAllRoutesState({ loading: false, computing: false, error: null });
    })();

    return () => {
      cancelled = true;
    };
  }, [showAllRoutes, settings.mergeOverlappingRoutes, allData, matcher, settings.coverageToleranceMeters]);

  const allRouteByKey = useMemo(() => {
    const map = new Map<string, BusRoute>();
    const source = networkData ?? allData;
    if (source) {
      for (const route of source.routes) {
        map.set(routeKey(route.routeUID, route.direction), route);
      }
    }
    return map;
  }, [allData, networkData]);

  // 路線清單與總覽共用相同的路線類別篩選。
  const filteredRouteList = useMemo(
    () =>
      routeList.filter(
        (route) =>
          routeTypeVisible(route, settings) &&
          (settings.operatorFilter === "all" ||
            route.operatorIDs.includes(settings.operatorFilter)),
      ),
    [routeList, settings],
  );
  const hiddenRouteCount = routeList.length - filteredRouteList.length;

  const operatorOptions = useMemo(() => {
    const names = new Map<string, string>();
    for (const route of routeList) {
      route.operatorIDs.forEach((id, index) => {
        if (id && !names.has(id)) names.set(id, route.operatorNames[index] ?? id);
      });
    }
    return [...names.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  }, [routeList]);

  /** 全部路線模式下通過篩選（路線類別、業者、方向）的路線 */
  const candidateRoutes = useMemo(() => {
    const source = settings.mergeOverlappingRoutes ? networkData : allData;
    if (!source) return [] as BusRoute[];

    let candidates = source.routes.filter(
      (route) =>
        routeTypeVisible(route, settings) &&
        (settings.operatorFilter === "all" ||
          route.operatorIDs.includes(settings.operatorFilter)),
    );

    const preferredDirection =
      settings.directionFilter === "both"
        ? null
        : settings.directionFilter === "outbound"
          ? (0 as const)
          : (1 as const);
    if (preferredDirection !== null) {
      const hasPreferred = new Set(
        candidates
          .filter((route) => route.direction === preferredDirection)
          .map((route) => route.routeUID),
      );
      candidates = candidates.filter(
        (route) =>
          route.direction === preferredDirection ||
          !hasPreferred.has(route.routeUID),
      );
    }

    return candidates;
  }, [
    allData,
    networkData,
    settings.mergeOverlappingRoutes,
    settings,
    settings.operatorFilter,
    settings.directionFilter,
  ]);

  // 幾何已預先建立；個人紀錄只在背景更新覆蓋狀態。
  useEffect(() => {
    if (!showAllRoutes || !networkData || !settings.mergeOverlappingRoutes) {
      setAllNetwork((previous) => (previous === null ? previous : null));
      return;
    }

    const keys = new Set(candidateRoutes.map((route) => routeKey(route.routeUID, route.direction)));
    const network = networkData.network.flatMap((chain) => {
      const routeKeys = chain.routeKeys.filter((key) => keys.has(key));
      return routeKeys.length ? [{ ...chain, routeKeys, sourceRouteKeys: chain.routeKeys }] : [];
    });
    if (rideRecords.length === 0) {
      setAllNetwork(network);
      setAllRoutesState({ loading: false, computing: false, error: null });
      return;
    }
    setAllRoutesState((previous) =>
      previous.computing ? previous : { ...previous, computing: true, error: null },
    );

    const worker = new Worker(new URL("../lib/geometry/coverage.worker.ts", import.meta.url));
    worker.onmessage = (event: MessageEvent<{ network?: RoadNetworkChain[]; error?: string }>) => {
      if (event.data.network) setAllNetwork(event.data.network);
      setAllRoutesState({ loading: false, computing: false, error: event.data.error ?? null });
      worker.terminate();
    };
    worker.onerror = (event) => {
      setAllRoutesState({ loading: false, computing: false, error: event.message || "覆蓋計算失敗" });
      worker.terminate();
    };
    worker.postMessage({ network, records: rideRecords, tolerance: settings.coverageToleranceMeters, shapeHashes: networkData.shapeHashes });
    return () => worker.terminate();
  }, [
    showAllRoutes,
    networkData,
    rideRecords,
    settings.mergeOverlappingRoutes,
    settings.coverageToleranceMeters,
    candidateRoutes,
  ]);

  const networkChains: NetworkChainData[] = useMemo(() => {
    if (!showAllRoutes || !allNetwork || !settings.mergeOverlappingRoutes) return [];
    return allNetwork.map((chain) => ({
      points: chain.points,
      level: chain.level,
      fastRoad: chain.fastRoad,
      ramp: chain.ramp,
      covered: chain.covered,
      routeNames: chain.routeKeys
        .map((key) => allRouteByKey.get(key))
        .filter((route): route is BusRoute => Boolean(route))
        .map((route) => fullRouteName(route)),
    }));
  }, [showAllRoutes, allNetwork, settings.mergeOverlappingRoutes, allRouteByKey]);

  // ---------- 地圖資料 ----------

  const mapRoutes: MapRouteData[] = useMemo(() => {
    if (showAllRoutes && (settings.mergeOverlappingRoutes || allData)) {
      const selected = selectedKey ? loadedRoutes[selectedKey] : undefined;
      const routes: MapRouteData[] = [];

      if (settings.mergeOverlappingRoutes && allNetwork) {
        // 路網由 MapView 以 multi-polyline 繪製；這裡只回傳選取路線（含站牌）
        if (selectedKey && selected?.shape) {
          // 總覽的選取高亮亦使用同一套道路骨架，避免疊回有偏移的原始 Shape。
          const chunks = allNetwork.filter((chain) => chain.routeKeys.includes(selectedKey))
            .map((chain) => ({ points: chain.points, covered: chain.covered }));
          routes.push({
            routeKey: selectedKey,
            routeName: fullRouteName(selected.route),
            direction: selected.route.direction,
            chunks,
            stops: selected.stops,
            isSelected: true,
            showStops: true,
            weight: 6,
            opacity: 0.9,
            smoothFactor: 1.5,
            bounds: boundsOfChunks(chunks),
          });
        }
        return routes;
      }

      if (settings.mergeOverlappingRoutes || !allData) return routes;

      // 未合併：每條候選路線各自繪製
      for (const route of candidateRoutes) {
        const key = routeKey(route.routeUID, route.direction);
        const isSelected = key === selectedKey;
        const chunks =
          isSelected && selected?.shape
            ? computeCoverage(selected.shape.geometry, matcher)
            : (allChunks?.[key] ?? null);
        if (!chunks || chunks.length === 0) continue;

        routes.push({
          routeKey: key,
          routeName: fullRouteName(route),
          direction: route.direction,
          chunks,
          stops: isSelected ? (selected?.stops ?? allData.stops[key] ?? []) : [],
          isSelected,
          showStops: isSelected,
          weight: isSelected ? 6 : 2.5,
          opacity: isSelected ? 0.9 : 0.45,
          smoothFactor: isSelected ? 1.5 : 5,
          bounds: boundsOfChunks(chunks),
        });
      }

      return routes;
    }

    const entries = Object.values(loadedRoutes);
    const visible = settings.onlyShowSelectedRoute
      ? entries.filter(
          (loaded) => routeKey(loaded.route.routeUID, loaded.route.direction) === selectedKey,
        )
      : entries;

    return visible.map((loaded) => {
      const key = routeKey(loaded.route.routeUID, loaded.route.direction);
      const isSelected = key === selectedKey;
      const hasMany = visible.length > 1;
      const chunks = settings.mergeOverlappingRoutes && networkData
        ? computeNetworkCoverage(networkData.network.filter((chain) => chain.routeKeys.includes(key)), rideRecords, settings.coverageToleranceMeters, networkData.shapeHashes)
        : loaded.shape ? computeCoverage(loaded.shape.geometry, matcher) : [];
      return {
        routeKey: key,
        routeName: fullRouteName(loaded.route),
        direction: loaded.route.direction,
        chunks,
        stops: loaded.stops,
        isSelected,
        showStops: isSelected,
        weight: isSelected ? 6 : hasMany ? 3.5 : 5,
        opacity: isSelected ? 0.9 : hasMany ? 0.5 : 0.85,
        smoothFactor: 1,
        bounds: boundsOfChunks(chunks),
      };
    });
  }, [
    showAllRoutes,
    allData,
    allChunks,
    allNetwork,
    candidateRoutes,
    loadedRoutes,
    selectedKey,
    settings.onlyShowSelectedRoute,
    settings.mergeOverlappingRoutes,
    matcher,
    networkData,
    rideRecords,
    settings.coverageToleranceMeters,
  ]);

  const visibleRouteCount =
    showAllRoutes && ((settings.mergeOverlappingRoutes && allNetwork) || (allData && allChunks))
      ? networkChains.length > 0
        ? networkChains.length + mapRoutes.length
        : mapRoutes.length
      : null;
  const visibleMemberCount =
    showAllRoutes && (networkData || allData) ? candidateRoutes.length : null;

  // ---------- 搭乘紀錄操作 ----------

  const refreshRideRecords = useCallback(async () => {
    setRideRecords(await getAllRideRecords());
  }, []);

  const handleMarkSegment = useCallback(async () => {
    if (!selectedRoute || !selectedSlice) {
      setMessage({ kind: "info", text: "請先選擇有效的上下車站區間" });
      return;
    }
    setBusy(true);
    try {
      const existing = await findRideRecords({
        routeUID: selectedRoute.routeUID,
        direction: selectedRoute.direction,
        fromStopUID: selectedSlice.fromStop.stopUID,
        toStopUID: selectedSlice.toStop.stopUID,
      });
      await deleteRideRecords(existing.map((record) => record.id));

      const record: RideRecord = {
        id: createRideRecordId(),
        routeUID: selectedRoute.routeUID,
        routeID: selectedRoute.routeID,
        routeName: fullRouteName(selectedRoute),
        direction: selectedRoute.direction,
        fromStopUID: selectedSlice.fromStop.stopUID,
        toStopUID: selectedSlice.toStop.stopUID,
        fromStopName: selectedSlice.fromStop.stopName,
        toStopName: selectedSlice.toStop.stopName,
        fullRoute: false,
        geometry: selectedSlice.points,
        createdAt: new Date().toISOString(),
      };
      await addRideRecord(record);
      await refreshRideRecords();
      setMessage({
        kind: "success",
        text: `已標記 ${record.routeName} ${directionLabel(record.direction)}：${record.fromStopName} → ${record.toStopName}`,
      });
    } catch (error) {
      setMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [selectedRoute, selectedSlice, refreshRideRecords]);

  const handleMarkFullRoute = useCallback(async () => {
    if (!selectedRoute || !selectedLoaded?.shape) return;
    setBusy(true);
    try {
      const stops = selectedLoaded.stops;
      const first = stops[0] ?? null;
      const last = stops.length > 0 ? stops[stops.length - 1] : null;
      const existing = await findRideRecords({
        routeUID: selectedRoute.routeUID,
        direction: selectedRoute.direction,
      });
      const duplicates =
        first && last
          ? existing.filter(
              (record) =>
                record.fromStopUID === first.stopUID && record.toStopUID === last.stopUID,
            )
          : existing.filter((record) => record.fullRoute);
      await deleteRideRecords(duplicates.map((record) => record.id));

      const record: RideRecord = {
        id: createRideRecordId(),
        routeUID: selectedRoute.routeUID,
        routeID: selectedRoute.routeID,
        routeName: fullRouteName(selectedRoute),
        direction: selectedRoute.direction,
        fromStopUID: first?.stopUID ?? null,
        toStopUID: last?.stopUID ?? null,
        fromStopName: first?.stopName ?? null,
        toStopName: last?.stopName ?? null,
        fullRoute: true,
        geometry: selectedLoaded.shape.geometry,
        createdAt: new Date().toISOString(),
      };
      await addRideRecord(record);
      await refreshRideRecords();
      setMessage({
        kind: "success",
        text: `已標記 ${record.routeName} ${directionLabel(record.direction)} 全程已搭乘`,
      });
    } catch (error) {
      setMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [selectedRoute, selectedLoaded, refreshRideRecords]);

  const handleCancelSegment = useCallback(async () => {
    if (!selectedRoute || !selectedSlice) {
      setMessage({ kind: "info", text: "請先選擇要取消的上下車站區間" });
      return;
    }
    setBusy(true);
    try {
      const existing = await findRideRecords({
        routeUID: selectedRoute.routeUID,
        direction: selectedRoute.direction,
        fromStopUID: selectedSlice.fromStop.stopUID,
        toStopUID: selectedSlice.toStop.stopUID,
      });
      if (existing.length === 0) {
        setMessage({ kind: "info", text: "找不到對應的區間紀錄" });
        return;
      }
      await deleteRideRecords(existing.map((record) => record.id));
      await refreshRideRecords();
      setMessage({ kind: "success", text: `已取消 ${existing.length} 筆區間紀錄` });
    } catch (error) {
      setMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [selectedRoute, selectedSlice, refreshRideRecords]);

  const handleDeleteRecord = useCallback(
    async (id: string) => {
      await deleteRideRecord(id);
      await refreshRideRecords();
    },
    [refreshRideRecords],
  );

  // ---------- 設定 ----------

  const handleSettingsChange = useCallback((next: AppSettings) => {
    setSettings(next);
    void saveSettings(next);
  }, []);

  // ---------- 匯出 / 匯入 / 清除 ----------

  const handleExport = useCallback(async () => {
    try {
      const bundle = await buildExportBundle();
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      downloadJson(`taichung-bus-coverage-${stamp}.json`, bundle);
      setMessage({
        kind: "success",
        text: `已匯出 ${bundle.rideRecords.length} 筆搭乘紀錄（不含 TDX/OSM 圖資）`,
      });
    } catch (error) {
      setMessage({ kind: "error", text: (error as Error).message });
    }
  }, []);

  const handleImportFile = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const bundle = parseImportBundle(text);
        const confirmed = window.confirm(
          `匯入將以檔案中的 ${bundle.rideRecords.length} 筆紀錄取代目前 ${rideRecords.length} 筆，確定要繼續嗎？`,
        );
        if (!confirmed) return;
        await applyImportBundle(bundle);
        setSettings(bundle.settings);
        await refreshRideRecords();
        setMessage({
          kind: "success",
          text: `已匯入 ${bundle.rideRecords.length} 筆搭乘紀錄`,
        });
      } catch (error) {
        setMessage({ kind: "error", text: (error as Error).message });
      }
    },
    [rideRecords.length, refreshRideRecords],
  );

  const handleClearRecords = useCallback(async () => {
    const confirmed = window.confirm(
      `確定要清除全部 ${rideRecords.length} 筆搭乘紀錄嗎？此動作無法復原（TDX 圖資快取不受影響）。`,
    );
    if (!confirmed) return;
    await clearRideRecords();
    await refreshRideRecords();
    setMessage({ kind: "success", text: "已清除所有個人搭乘紀錄" });
  }, [rideRecords.length, refreshRideRecords]);

  const handleRefreshTdx = useCallback(async () => {
    if (!tdxStatus?.prefetch.available) {
      setMessage({
        kind: "info",
        text: "尚未建立公車資料，請先執行 npm run prefetch:tdx",
      });
      return;
    }
    const confirmed = window.confirm(
      "將清除瀏覽器快取並重新從 Server 端的公車資料檔載入（不會連線 TDX）。個人搭乘紀錄不受影響。繼續？",
    );
    if (!confirmed) return;

    setBusy(true);
    try {
      await clearTdxCache();
      pendingForceRef.current = true;
      setLoadedRoutes({});
      setAllData(null);
      setNetworkData(null);
      setAllChunks(null);
      setAllNetwork(null);
      setAllRoutesState({ loading: false, computing: false, error: null });
      const result = await refreshRouteList(true);
      const prefetch = await fetchTdxStatus();
      setTdxStatus(prefetch);
      setMessage({
        kind: "success",
        text: `已重新載入公車資料（共 ${result.routes.length} 筆路線）`,
      });
    } catch (error) {
      setMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [tdxStatus?.prefetch.available, refreshRouteList]);

  const togglePanel = useCallback(() => {
    setSettings((previous) => {
      const next = { ...previous, panelCollapsed: !previous.panelCollapsed };
      void saveSettings(next);
      return next;
    });
  }, []);

  return (
    <div className={`app${settings.panelCollapsed ? " panel-collapsed" : ""}`}>
      {!settings.panelCollapsed && (
      <ControlPanel
        tdxStatus={tdxStatus}
        routeList={filteredRouteList}
        hiddenRouteCount={hiddenRouteCount}
        operatorOptions={operatorOptions}
        loadingRoutes={loadingRoutes}
        selectedRoute={selectedRoute}
        selectedLoaded={selectedLoaded ?? null}
        availableDirections={availableDirections}
        selectedKey={selectedKey}
        sliceInfo={sliceInfo}
        fromStopUID={fromStopUID}
        toStopUID={toStopUID}
        settings={settings}
        rideRecords={rideRecords}
        busy={busy}
        message={message}
        allRoutesState={{ ...allRoutesState, qualityNote: settings.mergeOverlappingRoutes ? networkData?.qualityNote : undefined }}
        routeCount={filteredRouteList.length}
        visibleRouteCount={visibleRouteCount}
        visibleMemberCount={visibleMemberCount}
        networkMode={networkChains.length > 0}
        onSelectRoute={handleSelectRoute}
        onSwitchDirection={handleSwitchDirection}
        onFromStopChange={setFromStopUID}
        onToStopChange={setToStopUID}
        onMarkSegment={handleMarkSegment}
        onMarkFullRoute={handleMarkFullRoute}
        onCancelSegment={handleCancelSegment}
        onRetryLoad={handleRetryLoad}
        onSettingsChange={handleSettingsChange}
        onDeleteRecord={handleDeleteRecord}
        onExport={handleExport}
        onImportFile={handleImportFile}
        onClearRecords={handleClearRecords}
        onRefreshTdx={handleRefreshTdx}
      />
      )}
      <main className="map-wrap">
        <button
          type="button"
          className="panel-toggle"
          onClick={togglePanel}
          disabled={!settingsReady}
          title={settings.panelCollapsed ? "顯示選單" : "收起選單"}
        >
          {settings.panelCollapsed ? "☰ 顯示選單" : "‹ 收起選單"}
        </button>
        <MapView
          key={city ?? "pending"}
          initialCenter={tdxStatus?.prefetch.mapCenter ?? undefined}
          routes={mapRoutes}
          network={networkChains.length > 0 ? networkChains : null}
          hideExploredChunks={settings.hideExploredSegments}
          fitToken={fitToken}
        />
        {(allRoutesState.loading || allRoutesState.computing) && showAllRoutes && (
          <div className="map-overlay">
            {allRoutesState.loading ? "正在載入路網…" : "正在計算覆蓋狀態…"}
          </div>
        )}
      </main>
    </div>
  );
}
