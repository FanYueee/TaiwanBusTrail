"use client";

import { useRef } from "react";

import { formatDateTime } from "./format";

import type { AllRoutesState, TdxStatus } from "./types";
import {
  SETTINGS_LIMITS,
  directionLabel,
  type AppSettings,
  type RideRecord,
} from "@/lib/types";

interface SettingsPanelProps {
  settings: AppSettings;
  tdxStatus: TdxStatus | null;
  rideRecords: RideRecord[];
  busy: boolean;
  allRoutesState: AllRoutesState;
  routeCount: number;
  visibleRouteCount: number | null;
  visibleMemberCount: number | null;
  networkMode: boolean;
  operatorOptions: { id: string; name: string }[];
  onSettingsChange: (settings: AppSettings) => void;
  onDeleteRecord: (id: string) => void;
  onExport: () => void;
  onImportFile: (file: File) => void;
  onClearRecords: () => void;
  onRefreshTdx: () => void;
}

export default function SettingsPanel({
  settings,
  tdxStatus,
  rideRecords,
  busy,
  allRoutesState,
  routeCount,
  visibleRouteCount,
  visibleMemberCount,
  networkMode,
  operatorOptions,
  onSettingsChange,
  onDeleteRecord,
  onExport,
  onImportFile,
  onClearRecords,
  onRefreshTdx,
}: SettingsPanelProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const prefetch = tdxStatus?.prefetch ?? null;
  const showAll = !settings.onlyShowSelectedRoute;

  return (
    <>
      <section className="panel-section">
        <h2>顯示設定</h2>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.onlyShowSelectedRoute}
            onChange={(event) =>
              onSettingsChange({
                ...settings,
                onlyShowSelectedRoute: event.target.checked,
              })
            }
          />
          只顯示目前選擇路線
        </label>
        <p className="muted small">
          {prefetch?.available
            ? `取消勾選即在地圖上顯示全部 ${routeCount || prefetch.routeCount} 條路線（紅／綠覆蓋總覽）`
            : "取消勾選會顯示已載入的路線；要顯示全部路線請先執行 npm run prefetch:tdx"}
        </p>

        <div className="field">
          <span>全部路線方向</span>
          <div className="direction-toggle">
            {(
              [
                { value: "outbound", label: "去程" },
                { value: "inbound", label: "返程" },
                { value: "both", label: "都要" },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                className={settings.directionFilter === option.value ? "active" : ""}
                onClick={() =>
                  onSettingsChange({ ...settings, directionFilter: option.value })
                }
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <p className="muted small">
          去／返程路徑常幾乎重疊，只顯示單向可減少線條與負擔；只有單向的路線會自動保留。
        </p>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.mergeOverlappingRoutes}
            onChange={(event) =>
              onSettingsChange({
                ...settings,
                mergeOverlappingRoutes: event.target.checked,
              })
            }
          />
          合併重疊路線（同一條路只畫一條）
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.showHuangRoutes}
            onChange={(event) =>
              onSettingsChange({
                ...settings,
                showHuangRoutes: event.target.checked,
              })
            }
          />
          顯示黃X 小黃公車
        </label>

        <label className="field">
          <span>公車業者</span>
          <select
            value={settings.operatorFilter}
            onChange={(event) =>
              onSettingsChange({ ...settings, operatorFilter: event.target.value })
            }
          >
            <option value="all">全部業者</option>
            {operatorOptions.map((operator) => (
              <option key={operator.id} value={operator.id}>
                {operator.name}
              </option>
            ))}
          </select>
        </label>
        {showAll && allRoutesState.loading && (
          <p className="muted small">正在載入全部線型…</p>
        )}
        {showAll && allRoutesState.computing && (
          <p className="muted small">正在計算覆蓋狀態…</p>
        )}
        {showAll &&
          visibleRouteCount !== null &&
          !allRoutesState.computing &&
          !allRoutesState.loading && (
            <p className="muted small">
              {networkMode
                ? `已顯示合併路網（涵蓋 ${visibleMemberCount ?? 0} 條路線）`
                : `已顯示 ${visibleRouteCount} 條路線（僅顯示有線型資料者）`}
            </p>
          )}
        {allRoutesState.error && <div className="message warn">{allRoutesState.error}</div>}

        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.hideExploredSegments}
            onChange={(event) =>
              onSettingsChange({
                ...settings,
                hideExploredSegments: event.target.checked,
              })
            }
          />
          隱藏已走過路段
        </label>
        <label className="field">
          <span>
            幾何比對容差：{settings.coverageToleranceMeters} m
          </span>
          <input
            type="range"
            min={SETTINGS_LIMITS.minToleranceMeters}
            max={SETTINGS_LIMITS.maxToleranceMeters}
            step={1}
            value={settings.coverageToleranceMeters}
            onChange={(event) =>
              onSettingsChange({
                ...settings,
                coverageToleranceMeters: Number(event.target.value),
              })
            }
          />
        </label>
        <p className="muted small">
          容差越大越容易將相近道路視為同一條；15 m 適用於 TDX Shape 對 TDX Shape 的比對。
        </p>
      </section>

      <section className="panel-section">
        <h2>搭乘紀錄（{rideRecords.length}）</h2>
        {rideRecords.length === 0 ? (
          <p className="muted">尚無紀錄。</p>
        ) : (
          <ul className="record-list">
            {rideRecords.map((record) => (
              <li key={record.id}>
                <div className="record-text">
                  <strong>{record.routeName}</strong> {directionLabel(record.direction)}
                  <br />
                  <span className="muted small">
                    {record.fullRoute
                      ? "全程"
                      : `${record.fromStopName ?? "?"} → ${record.toStopName ?? "?"}`}
                    {" · "}
                    {formatDateTime(record.createdAt)}
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  title="刪除此紀錄"
                  onClick={() => onDeleteRecord(record.id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel-section">
        <h2>本機資料</h2>
        <p className="muted small">
          個人資料只儲存在此瀏覽器（IndexedDB），不會上傳。
        </p>
        <div className="button-row">
          <button type="button" onClick={onExport}>
            匯出個人資料 JSON
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()}>
            匯入個人資料 JSON
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onImportFile(file);
              event.target.value = "";
            }}
          />
          <button type="button" className="danger" onClick={onClearRecords}>
            清除所有個人紀錄
          </button>
        </div>
      </section>

      <section className="panel-section">
        <h2>公車資料（半離線）</h2>
        <p className="muted small">
          App 執行期不連線 TDX，路線／線型／站牌都來自 Server 端預先下載的資料檔。
        </p>

        {!prefetch ? (
          <p className="muted small">檢查中…</p>
        ) : prefetch.available ? (
          <p className="muted small">
            路線 {prefetch.routeCount} 筆、線型 {prefetch.shapeCount} 筆
            {prefetch.missingShapeCount > 0
              ? `（${prefetch.missingShapeCount} 筆 TDX 無線型）`
              : ""}
            、站牌 {prefetch.stopCount} 筆
            <br />
            資料建立時間：{formatDateTime(prefetch.prefetchedAt)}
          </p>
        ) : (
          <div className="message warn">
            尚未建立公車資料。請在專案目錄執行 <code>npm run prefetch:tdx</code>
            後重新整理頁面。
          </div>
        )}

        <button
          type="button"
          onClick={onRefreshTdx}
          disabled={busy || !prefetch?.available}
        >
          重新載入公車資料
        </button>
        <p className="muted small">
          重新載入只會清除瀏覽器快取並重讀本地資料檔；要更新 TDX 官方資料請執行{" "}
          <code>npm run prefetch:tdx</code>（約 8 分鐘）。
        </p>
      </section>
    </>
  );
}
