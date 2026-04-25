import { NextResponse } from "next/server";
import { stopTradingTask } from "@/lib/trade/scheduler";

export async function POST() {
  const result = stopTradingTask();
  return NextResponse.json({ ok: true, data: result });
}
