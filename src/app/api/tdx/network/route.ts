import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { loadPrefetched } from "@/lib/tdx/server";
import { tdxDataFile } from "@/lib/tdx/dataDir";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const bundle = await loadPrefetched();
    const network = JSON.parse(await readFile(tdxDataFile("network.json"), "utf8"));
    if (!bundle || network.version !== 4 || network.prefetchedAt !== bundle.meta?.prefetchedAt) {
      throw new Error("stale network");
    }
    return NextResponse.json({ routes: bundle.routes, network: network.network, reports: network.reports, shapeHashes: network.shapeHashes });
  } catch {
    return NextResponse.json({ error: "共用路網尚未建立或已過期，請執行 npm run build:network" }, { status: 409 });
  }
}
