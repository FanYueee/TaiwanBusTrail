"use client";

import RideForm from "./RideForm";
import RouteSearch from "./RouteSearch";
import SettingsPanel from "./SettingsPanel";

import type { AllRoutesState, LoadedRoute, PanelMessage, SliceInfo, TdxStatus } from "./types";
import { LEGEND_ITEMS } from "@/lib/map/colors";
import type { AppSettings, BusRoute, Direction, RideRecord } from "@/lib/types";

interface ControlPanelProps {
  tdxStatus: TdxStatus | null;
  routeList: BusRoute[];
  hiddenRouteCount: number;
  operatorOptions: { id: string; name: string }[];
  loadingRoutes: boolean;
  selectedRoute: BusRoute | null;
  selectedLoaded: LoadedRoute | null;
  availableDirections: BusRoute[];
  selectedKey: string | null;
  sliceInfo: SliceInfo | null;
  fromStopUID: string;
  toStopUID: string;
  settings: AppSettings;
  rideRecords: RideRecord[];
  busy: boolean;
  message: PanelMessage | null;
  allRoutesState: AllRoutesState;
  routeCount: number;
  visibleRouteCount: number | null;
  visibleMemberCount: number | null;
  networkMode: boolean;
  onSelectRoute: (route: BusRoute) => void;
  onSwitchDirection: (direction: Direction) => void;
  onFromStopChange: (stopUID: string) => void;
  onToStopChange: (stopUID: string) => void;
  onMarkSegment: () => void;
  onMarkFullRoute: () => void;
  onCancelSegment: () => void;
  onRetryLoad: () => void;
  onSettingsChange: (settings: AppSettings) => void;
  onDeleteRecord: (id: string) => void;
  onExport: () => void;
  onImportFile: (file: File) => void;
  onClearRecords: () => void;
  onRefreshTdx: () => void;
}

export default function ControlPanel({
  tdxStatus,
  routeList,
  hiddenRouteCount,
  operatorOptions,
  loadingRoutes,
  selectedRoute,
  selectedLoaded,
  availableDirections,
  selectedKey,
  sliceInfo,
  fromStopUID,
  toStopUID,
  settings,
  rideRecords,
  busy,
  message,
  allRoutesState,
  routeCount,
  visibleRouteCount,
  visibleMemberCount,
  networkMode,
  onSelectRoute,
  onSwitchDirection,
  onFromStopChange,
  onToStopChange,
  onMarkSegment,
  onMarkFullRoute,
  onCancelSegment,
  onRetryLoad,
  onSettingsChange,
  onDeleteRecord,
  onExport,
  onImportFile,
  onClearRecords,
  onRefreshTdx,
}: ControlPanelProps) {
  return (
    <aside className="panel">
      <header className="panel-header">
        <h1>台中公車覆蓋地圖</h1>
        <p className="muted small">實際行駛線型・搭乘紀錄只存在本機</p>
        <div className="legend">
          {LEGEND_ITEMS.map((item) => (
            <span key={item.label} className="legend-item">
              <span
                className="legend-swatch"
                style={{ backgroundColor: item.color }}
                aria-hidden="true"
              />
              {item.label}
            </span>
          ))}
        </div>
      </header>

      {message && <div className={`message ${message.kind}`}>{message.text}</div>}

      <RouteSearch
        routeList={routeList}
        hiddenRouteCount={hiddenRouteCount}
        loading={loadingRoutes}
        selectedKey={selectedKey}
        onSelectRoute={onSelectRoute}
      />

      {selectedRoute && (
        <RideForm
          selectedRoute={selectedRoute}
          loaded={selectedLoaded ?? null}
          availableDirections={availableDirections}
          sliceInfo={sliceInfo}
          fromStopUID={fromStopUID}
          toStopUID={toStopUID}
          onSwitchDirection={onSwitchDirection}
          onFromStopChange={onFromStopChange}
          onToStopChange={onToStopChange}
          onMarkSegment={onMarkSegment}
          onMarkFullRoute={onMarkFullRoute}
          onCancelSegment={onCancelSegment}
          onRetry={onRetryLoad}
          busy={busy}
        />
      )}

      <SettingsPanel
        settings={settings}
        tdxStatus={tdxStatus}
        rideRecords={rideRecords}
        busy={busy}
        allRoutesState={allRoutesState}
        routeCount={routeCount}
        visibleRouteCount={visibleRouteCount}
        visibleMemberCount={visibleMemberCount}
        networkMode={networkMode}
        operatorOptions={operatorOptions}
        onSettingsChange={onSettingsChange}
        onDeleteRecord={onDeleteRecord}
        onExport={onExport}
        onImportFile={onImportFile}
        onClearRecords={onClearRecords}
        onRefreshTdx={onRefreshTdx}
      />
    </aside>
  );
}
