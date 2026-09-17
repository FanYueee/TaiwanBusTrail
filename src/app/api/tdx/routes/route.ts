import { NextResponse } from "next/server";

import { PrefetchMissingError, fetchTaichungRoutes } from "@/lib/tdx/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  try {
    const routes = await fetchTaichungRoutes({ force });
    return NextResponse.json({ routes });
  } catch (error) {
    if (error instanceof PrefetchMissingError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: `無法讀取公車資料：${(error as Error).message}` },
      { status: 500 },
    );
  }
}
