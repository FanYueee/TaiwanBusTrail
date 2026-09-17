import { NextResponse } from "next/server";

import { loadPrefetched } from "@/lib/tdx/server";

export const dynamic = "force-dynamic";

/**
 * 一次回傳預先下載的全部路線 / 線型 / 站牌，供「顯示全部路線」使用。
 * 沒有預先下載資料時不即時抓取（755 筆會被 TDX 限流拖數小時），
 * 改回傳 409 並提示使用者執行 npm run prefetch:tdx。
 */
export async function GET() {
  const prefetched = await loadPrefetched();

  if (!prefetched) {
    return NextResponse.json(
      {
        error:
          "尚未預先下載 TDX 線型資料。請在專案目錄執行 npm run prefetch:tdx（約 8 分鐘）後重新整理。",
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    routes: prefetched.routes,
    shapes: prefetched.shapes,
    stops: prefetched.stops,
    meta: prefetched.meta,
  });
}
