import { NextResponse } from "next/server";
import { getTradingTaskStatus } from "@/lib/trade/scheduler";

export async function GET() {
  const status = await getTradingTaskStatus();
  return NextResponse.json({ ok: true, data: status });
}
