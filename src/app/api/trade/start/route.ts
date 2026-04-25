import { NextResponse } from "next/server";
import { startTradingTask } from "@/lib/trade/scheduler";

export async function POST() {
  try {
    const started = await startTradingTask();
    return NextResponse.json({ ok: true, data: started });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : "start failed" },
      { status: 500 },
    );
  }
}
