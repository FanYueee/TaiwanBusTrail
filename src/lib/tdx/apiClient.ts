/** TDX 代理 API 的共用 client（瀏覽器端） */

export class TdxRequestError extends Error {
  status: number;
  retryAfterSeconds: number | null;

  constructor(message: string, status: number, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "TdxRequestError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface TdxPrefetchInfo {
  available: boolean;
  prefetchedAt: string | null;
  routeCount: number;
  shapeCount: number;
  missingShapeCount: number;
  stopCount: number;
}

export interface TdxStatus {
  /** 瀏覽器 IndexedDB 快取 TTL（天） */
  cacheTtlDays: number;
  /** Server 端預先下載的公車資料狀態（App 執行期不呼叫 TDX） */
  prefetch: TdxPrefetchInfo;
}

export async function fetchTdxStatus(): Promise<TdxStatus> {
  const res = await fetch("/api/tdx/status");
  if (!res.ok) throw new TdxRequestError(`無法取得 TDX 狀態（HTTP ${res.status}）`, res.status);
  return (await res.json()) as TdxStatus;
}

export async function fetchTdxJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (error) {
    throw new TdxRequestError(`網路請求失敗：${(error as Error).message}`, 0);
  }

  const json = (await res.json().catch(() => null)) as
    | ({ error?: string; retryAfterSeconds?: number | null } & T)
    | null;

  if (!res.ok) {
    throw new TdxRequestError(
      json?.error ?? `請求失敗（HTTP ${res.status}）`,
      res.status,
      json?.retryAfterSeconds ?? null,
    );
  }

  return json as T;
}
