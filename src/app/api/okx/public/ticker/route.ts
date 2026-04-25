import { NextRequest, NextResponse } from "next/server";
import { okxAdapter } from "@/lib/okx/adapter";

export async function GET(request: NextRequest) {
  const instId = request.nextUrl.searchParams.get("instId") || "BTC-USDT-SWAP";
  try {
    const ticker = await okxAdapter.getTicker(instId);
    return NextResponse.json({ data: ticker });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Ticker fetch error" },
      { status: 500 },
    );
  }
}
