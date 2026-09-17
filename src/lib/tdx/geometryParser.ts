import type { LatLon } from "@/lib/types";

/**
 * TDX Shape 幾何解析
 *
 * 台中市 Bus Shape 的 Geometry 欄位經實測為 WKT `LINESTRING(lon lat, ...)`，
 * 另提供 `EncodedPolyline` 備援。兩種格式都支援，避免 TDX 格式調整時中斷。
 */

export function parseWktLineString(wkt: string): LatLon[] | null {
  const match = wkt.match(/LINESTRING\s*\(([^)]*)\)/i);
  if (!match) return null;
  const points: LatLon[] = [];
  for (const pair of match[1].split(",")) {
    const [lonText, latText] = pair.trim().split(/\s+/);
    const lon = Number(lonText);
    const lat = Number(latText);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      points.push({ lat, lon });
    }
  }
  return points.length >= 2 ? points : null;
}

/** Google encoded polyline 解碼（TDX EncodedPolyline 精度為 1e5） */
export function decodeEncodedPolyline(encoded: string, precision = 5): LatLon[] | null {
  const factor = 10 ** precision;
  const points: LatLon[] = [];
  let lat = 0;
  let lon = 0;
  let index = 0;

  const decodeValue = (): number | null => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length) return null;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    const dLat = decodeValue();
    if (dLat === null) return null;
    const dLon = decodeValue();
    if (dLon === null) return null;
    lat += dLat;
    lon += dLon;
    points.push({ lat: lat / factor, lon: lon / factor });
  }

  return points.length >= 2 ? points : null;
}

/**
 * 從任一種 TDX Shape 幾何表示法解析出座標陣列。
 * 回傳 null 代表該 Shape 無可用線型資料（不可用站牌直線代替）。
 */
export function parseTdxGeometry(input: unknown): LatLon[] | null {
  if (input == null) return null;

  if (typeof input === "string") {
    if (/LINESTRING/i.test(input)) {
      return parseWktLineString(input);
    }
    return decodeEncodedPolyline(input);
  }

  if (Array.isArray(input)) {
    const points: LatLon[] = [];
    for (const item of input) {
      if (Array.isArray(item) && item.length >= 2) {
        const lat = Number(item[0]);
        const lon = Number(item[1]);
        if (Number.isFinite(lat) && Number.isFinite(lon)) points.push({ lat, lon });
      } else if (
        item &&
        typeof item === "object" &&
        "lat" in item &&
        "lon" in item
      ) {
        const lat = Number((item as { lat: unknown }).lat);
        const lon = Number((item as { lon: unknown }).lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) points.push({ lat, lon });
      }
    }
    return points.length >= 2 ? points : null;
  }

  return null;
}
