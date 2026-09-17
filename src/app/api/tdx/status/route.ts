import { NextResponse } from "next/server";

import { getCacheTtlDays, getPrefetchInfo } from "@/lib/tdx/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const prefetch = await getPrefetchInfo();
  return NextResponse.json({
    cacheTtlDays: getCacheTtlDays(),
    prefetch,
  });
}
