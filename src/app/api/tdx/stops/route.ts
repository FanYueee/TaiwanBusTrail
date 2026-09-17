import { NextResponse } from "next/server";

import { PrefetchMissingError, fetchTaichungStops } from "@/lib/tdx/server";
import type { Direction } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const routeUID = searchParams.get("routeUID");
  const directionParam = searchParams.get("direction");

  if (!routeUID || (directionParam !== "0" && directionParam !== "1")) {
    return NextResponse.json(
      { error: "缺少有效參數：routeUID、direction（0 或 1）" },
      { status: 400 },
    );
  }

  const direction = Number(directionParam) as Direction;
  const force = searchParams.get("force") === "1";

  try {
    const stops = await fetchTaichungStops(routeUID, direction, { force });
    return NextResponse.json({ stops });
  } catch (error) {
    if (error instanceof PrefetchMissingError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: `無法讀取站牌資料：${(error as Error).message}` },
      { status: 500 },
    );
  }
}
