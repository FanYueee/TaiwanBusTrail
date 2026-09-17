"use client";

import { memo, useCallback, useMemo, useState } from "react";

import { directionLabel, fullRouteName, routeKey, type BusRoute } from "@/lib/types";

interface RouteSearchProps {
  routeList: BusRoute[];
  /** 因黃X／業者篩選而隱藏的路線數 */
  hiddenRouteCount: number;
  loading: boolean;
  selectedKey: string | null;
  onSelectRoute: (route: BusRoute) => void;
}

interface RouteRowProps {
  route: BusRoute;
  active: boolean;
  onSelect: (route: BusRoute) => void;
}

/**
 * 單列路線。路線清單可達 700+ 筆，使用 memo 避免每次選擇/搜尋都重新渲染全部列。
 */
const RouteRow = memo(function RouteRow({ route, active, onSelect }: RouteRowProps) {
  return (
    <li>
      <button
        type="button"
        className={active ? "route-item active" : "route-item"}
        onClick={() => onSelect(route)}
      >
        <span className="route-number">{fullRouteName(route)}</span>
        <span className="route-path">
          {route.departureStop || "?"}－{route.destinationStop || "?"}
        </span>
        <span className="route-direction">{directionLabel(route.direction)}</span>
      </button>
    </li>
  );
});

export default function RouteSearch({
  routeList,
  hiddenRouteCount,
  loading,
  selectedKey,
  onSelectRoute,
}: RouteSearchProps) {
  const [query, setQuery] = useState("");

  const handleSelect = useCallback(
    (route: BusRoute) => onSelectRoute(route),
    [onSelectRoute],
  );

  const results = useMemo(() => {
    const term = query.trim().toLowerCase();
    const matched = term
      ? routeList.filter((route) =>
          [
            route.routeName,
            route.subRouteName ?? "",
            route.departureStop,
            route.destinationStop,
          ].some((value) => value.toLowerCase().includes(term)),
        )
      : routeList;

    return [...matched].sort((a, b) =>
      a.routeName.localeCompare(b.routeName, "zh-Hant", { numeric: true }),
    );
  }, [routeList, query]);

  return (
    <section className="panel-section">
      <h2>搜尋路線</h2>
      <input
        type="search"
        className="search-input"
        placeholder="輸入路線編號或站名，例如 300"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {loading && routeList.length === 0 ? (
        <p className="muted">正在載入路線資料…</p>
      ) : routeList.length === 0 ? (
        <p className="muted">尚無路線資料，請按下方「更新公車資料」。</p>
      ) : (
        <>
          <ul className="route-list">
            {results.map((route) => {
              const key = routeKey(route.routeUID, route.direction);
              return (
                <RouteRow
                  key={key}
                  route={route}
                  active={key === selectedKey}
                  onSelect={handleSelect}
                />
              );
            })}
          </ul>
          <p className="muted small">
            顯示 {results.length} / {routeList.length} 筆（去返程分開）
            {hiddenRouteCount > 0
              ? `；另有 ${hiddenRouteCount} 筆因黃X／業者篩選隱藏`
              : ""}
          </p>
        </>
      )}
    </section>
  );
}
