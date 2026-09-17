"use client";

import { formatDistance } from "./format";

import type { LoadedRoute, SliceInfo } from "./types";
import { directionLabel, fullRouteName, type BusRoute, type Direction } from "@/lib/types";

interface RideFormProps {
  selectedRoute: BusRoute;
  loaded: LoadedRoute | null;
  availableDirections: BusRoute[];
  sliceInfo: SliceInfo | null;
  fromStopUID: string;
  toStopUID: string;
  onSwitchDirection: (direction: Direction) => void;
  onFromStopChange: (stopUID: string) => void;
  onToStopChange: (stopUID: string) => void;
  onMarkSegment: () => void;
  onMarkFullRoute: () => void;
  onCancelSegment: () => void;
  onRetry: () => void;
  busy: boolean;
}

export default function RideForm({
  selectedRoute,
  loaded,
  availableDirections,
  sliceInfo,
  fromStopUID,
  toStopUID,
  onSwitchDirection,
  onFromStopChange,
  onToStopChange,
  onMarkSegment,
  onMarkFullRoute,
  onCancelSegment,
  onRetry,
  busy,
}: RideFormProps) {
  const stops = loaded?.stops ?? [];
  const shapeMissing = loaded?.shapeMissing === true;
  const hasShape = loaded?.shape != null;

  return (
    <section className="panel-section">
      <h2>
        {fullRouteName(selectedRoute)}
        <span className="route-direction"> {directionLabel(selectedRoute.direction)}</span>
      </h2>

      <div className="direction-toggle">
        {availableDirections.map((route) => (
          <button
            key={route.direction}
            type="button"
            className={route.direction === selectedRoute.direction ? "active" : ""}
            onClick={() => onSwitchDirection(route.direction)}
          >
            {directionLabel(route.direction)}
          </button>
        ))}
      </div>

      {loaded?.loading && <p className="muted">正在載入官方線型與站牌…</p>}

      {loaded?.error && (
        <div className="message error">
          {loaded.error}
          <button type="button" className="link-button" onClick={onRetry}>
            重試
          </button>
        </div>
      )}

      {shapeMissing && (
        <div className="message warn">
          此路線 TDX 無可用線型資料，無法標記（不以站牌直線代替實際路徑）。
        </div>
      )}

      {hasShape && (
        <>
          <label className="field">
            <span>上車站</span>
            <select
              value={fromStopUID}
              onChange={(event) => onFromStopChange(event.target.value)}
            >
              {stops.map((stop) => (
                <option key={stop.stopUID} value={stop.stopUID}>
                  {stop.sequence}. {stop.stopName}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>下車站</span>
            <select value={toStopUID} onChange={(event) => onToStopChange(event.target.value)}>
              {stops.map((stop) => (
                <option key={stop.stopUID} value={stop.stopUID}>
                  {stop.sequence}. {stop.stopName}
                </option>
              ))}
            </select>
          </label>

          {sliceInfo && (
            <p className="muted small">
              選取區間：{sliceInfo.fromName} → {sliceInfo.toName}，共{" "}
              {sliceInfo.stationCount} 站、約 {formatDistance(sliceInfo.distanceMeters)}
            </p>
          )}

          <div className="button-row">
            <button
              type="button"
              className="primary"
              onClick={onMarkSegment}
              disabled={busy || !sliceInfo || fromStopUID === toStopUID}
            >
              標記這段已搭乘
            </button>
            <button type="button" onClick={onMarkFullRoute} disabled={busy}>
              整條標記已搭乘
            </button>
            <button type="button" onClick={onCancelSegment} disabled={busy}>
              取消這段紀錄
            </button>
          </div>
        </>
      )}
    </section>
  );
}
