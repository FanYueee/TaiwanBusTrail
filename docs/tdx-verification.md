# TDX 台中市公車 Shape 資料驗證（Phase 1）

> 驗證時間：2026-09-16T11:55:23.353Z
> 驗證方式：實際呼叫交通部 TDX 官方 API（本文件由 `scripts/verify-tdx.mjs` 產生）

## API Endpoint

| 用途 | Endpoint |
| --- | --- |
| 取得 token | `POST https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token`（grant_type=client_credentials） |
| Route | `GET https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City/Taichung?$format=JSON` |
| Shape | `GET https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/City/Taichung?$format=JSON&$filter=RouteUID eq '…' and Direction eq 0` |
| StopOfRoute | `GET https://tdx.transportdata.tw/api/basic/v2/Bus/StopOfRoute/City/Taichung?$format=JSON&$filter=RouteUID eq '…' and Direction eq 0` |

### 實際觀察到的資料結構

- `Route`：台中市資料的**方向資訊在 `SubRoutes[]` 內**，外層沒有 `Direction` 欄位。每筆 SubRoute 有 `SubRouteUID`、`SubRouteID`、`Direction`（0=去程、1=返程）、`Headsign`。
- `Shape`：回傳欄位 `RouteUID, RouteID, RouteName, SubRouteUID, SubRouteID, SubRouteName, Direction, Geometry, EncodedPolyline, UpdateTime, VersionID`。
- `Geometry` 為 **WKT `LINESTRING(經度 緯度, …)`** 字串；另有 `EncodedPolyline` 欄位可作為備援。
- `StopOfRoute`：`Stops[]` 內含 `StopUID, StopName.Zh_tw, StopSequence, StopPosition.PositionLat/PositionLon`。
- **TDX 速率限制：`x-ratelimit-limit-minute: 5`，即每分鐘 5 次請求**。App 端因此採用「隨選抓取 + IndexedDB 快取」，避免反覆大量請求。

台中市公車路線總筆數（Route）：**389**，攤平後（含方向/變體）：**755**

## 驗證結果

| 路線 | 方向 | RouteUID | Shape 格式 | Shape 點數 | 站牌數 | Shape 長度 (m) | 與站牌直線最大偏移 (m) | 彎曲區間 / 總區間 | 判定 |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 300 | 去程 | `TXG300` | WKT LINESTRING | 41 | 26 | 16957.4 | 526.5 | 8 / 25 | ✅ 實際道路線型 |
| 300 | 返程 | `TXG300` | WKT LINESTRING | 39 | 24 | 17714.7 | 541.5 | 7 / 23 | ✅ 實際道路線型 |
| 5 | 去程 | `TXG5` | WKT LINESTRING | 129 | 50 | 15958.9 | 236.4 | 24 / 49 | ✅ 實際道路線型 |
| 5 | 返程 | `TXG5` | WKT LINESTRING | 137 | 50 | 15565.7 | 193.0 | 17 / 49 | ✅ 實際道路線型 |
| 35 | 去程 | `TXG35` | WKT LINESTRING | 133 | 62 | 17517.5 | 228.3 | 21 / 61 | ✅ 實際道路線型 |
| 35 | 返程 | `TXG35` | WKT LINESTRING | 139 | 61 | 17660.9 | 202.6 | 29 / 60 | ✅ 實際道路線型 |
| 307 | 去程 | `TXG307` | WKT LINESTRING | 77 | 65 | 32531.2 | 526.5 | 20 / 64 | ✅ 實際道路線型 |
| 307 | 返程 | `TXG307` | WKT LINESTRING | 78 | 65 | 32789.8 | 541.5 | 21 / 64 | ✅ 實際道路線型 |
| 33 | 去程 | `TXG33` | WKT LINESTRING | 173 | 77 | 26352.5 | 264.4 | 31 / 76 | ✅ 實際道路線型 |
| 33 | 返程 | `TXG33` | WKT LINESTRING | 164 | 79 | 26348.1 | 396.0 | 30 / 78 | ✅ 實際道路線型 |

### 判定方式

- **與站牌直線最大偏移**：將站牌依 sequence 連成折線後，計算 Shape 每個頂點到該折線的最近距離（公尺）。若只是把站牌連直線，此值應接近 0；實際道路線型會出現數十至數百公尺的偏移。
- **彎曲區間**：對每組相鄰站牌，取 Shape 對應區段的實際道路長度 ÷ 兩站直線距離。比值 > 1.15 視為該區間具有實際道路轉折。
- **Shape 長度 vs 站牌折線長度**：實際線型通常大於站牌折線總長（見原始數據）。

## 結論

- ✅ 已實際取得 **10** 條台中市公車路線（含方向）的 TDX Shape，內容包含站牌之間的道路轉折，**不是 stop-to-stop 直線**。
- Shape 欄位格式與座標點數量見上表；程式端（`src/lib/tdx/geometryParser.ts`）同時支援 WKT LINESTRING 與 encoded polyline。

## 範例 Shape 資料

### 300 路（去程）

- RouteUID：`TXG300`
- Shape 原始欄位：`["RouteUID","RouteID","RouteName","SubRouteUID","SubRouteID","SubRouteName","Direction","Geometry","EncodedPolyline","UpdateTime","VersionID"]`
- 格式：`WKT LINESTRING`
- Shape 點數：41，站牌數：26
- 原始內容開頭：`LINESTRING(120.57659 24.22599,120.57683 24.22560,120.57914 24.22197,120.57958 24.22112,120.58000 24.21997,120.58055 24.21614,120.58132 24.20979,120.58145 24.207`

- 前 5 個座標點：

```json
[
  {
    "lon": 120.57659,
    "lat": 24.22599
  },
  {
    "lon": 120.57683,
    "lat": 24.2256
  },
  {
    "lon": 120.57914,
    "lat": 24.22197
  },
  {
    "lon": 120.57958,
    "lat": 24.22112
  },
  {
    "lon": 120.58,
    "lat": 24.21997
  }
]
```

- 最後 3 個座標點：

```json
[
  {
    "lon": 120.68485,
    "lat": 24.13752
  },
  {
    "lon": 120.68587,
    "lat": 24.13759
  },
  {
    "lon": 120.68648,
    "lat": 24.13775
  }
]
```

- 前 5 站：

```json
[
  {
    "name": "靜宜大學(專用道)",
    "sequence": 1,
    "lat": 24.225899,
    "lon": 120.576539
  },
  {
    "name": "晉江寮(專用道)",
    "sequence": 2,
    "lat": 24.221858,
    "lon": 120.579074
  },
  {
    "name": "弘光科技大學(專用道)",
    "sequence": 3,
    "lat": 24.217481,
    "lon": 120.580258
  },
  {
    "name": "正英路(專用道)",
    "sequence": 4,
    "lat": 24.209925,
    "lon": 120.581137
  },
  {
    "name": "坪頂(專用道)",
    "sequence": 5,
    "lat": 24.186045538196,
    "lon": 120.58566809429
  }
]
```

### 300 路（返程）

- RouteUID：`TXG300`
- Shape 原始欄位：`["RouteUID","RouteID","RouteName","SubRouteUID","SubRouteID","SubRouteName","Direction","Geometry","EncodedPolyline","UpdateTime","VersionID"]`
- 格式：`WKT LINESTRING`
- Shape 點數：39，站牌數：24
- 原始內容開頭：`LINESTRING(120.68648 24.13775,120.68712 24.13810,120.68777 24.13810,120.68782 24.14012,120.68600 24.14015,120.68589 24.14317,120.68537 24.14317,120.68225 24.140`

- 前 5 個座標點：

```json
[
  {
    "lon": 120.68648,
    "lat": 24.13775
  },
  {
    "lon": 120.68712,
    "lat": 24.1381
  },
  {
    "lon": 120.68777,
    "lat": 24.1381
  },
  {
    "lon": 120.68782,
    "lat": 24.14012
  },
  {
    "lon": 120.686,
    "lat": 24.14015
  }
]
```

- 最後 3 個座標點：

```json
[
  {
    "lon": 120.57982,
    "lat": 24.22081
  },
  {
    "lon": 120.57936,
    "lat": 24.22179
  },
  {
    "lon": 120.57707,
    "lat": 24.22541
  }
]
```

- 前 5 站：

```json
[
  {
    "name": "臺中車站(A月台)",
    "sequence": 1,
    "lat": 24.137749,
    "lon": 120.686459
  },
  {
    "name": "第二市場(臺灣大道)",
    "sequence": 2,
    "lat": 24.141998,
    "lon": 120.680134
  },
  {
    "name": "仁愛醫院",
    "sequence": 3,
    "lat": 24.143748,
    "lon": 120.678061
  },
  {
    "name": "臺灣大道中華路口",
    "sequence": 4,
    "lat": 24.144813,
    "lon": 120.676905
  },
  {
    "name": "臺灣大道原子街口",
    "sequence": 5,
    "lat": 24.146572,
    "lon": 120.674872
  }
]
```
