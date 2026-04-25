import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runDecisionEngine } from "@/lib/engine/decision-engine";
import { executeOrder } from "@/lib/engine/execution-engine";

const payloadSchema = z.object({
  symbol: z.string().default("BTC-USDT-SWAP"),
  timeframe: z.string().default("15m"),
  execute: z.boolean().default(false),
});

export async function POST(request: NextRequest) {
  const payload = payloadSchema.parse(await request.json());

  const result = await runDecisionEngine({
    symbol: payload.symbol,
    timeframe: payload.timeframe,
  });

  if (!payload.execute || !result.decision || result.blockedByRisk) {
    return NextResponse.json({
      decision: result.decision,
      blockedByRisk: result.blockedByRisk,
      blockReason: result.blockReason,
      executed: false,
    });
  }

  if (!["buy", "sell"].includes(result.decision.action)) {
    return NextResponse.json({
      decision: result.decision,
      blockedByRisk: result.blockedByRisk,
      blockReason: result.blockReason,
      executed: false,
      message: "当前动作不需要下单",
    });
  }

  const order = await executeOrder({
    symbol: payload.symbol,
    side: result.decision.action === "buy" ? "buy" : "sell",
    quantity: 0.01,
    source: "ai",
    aiDecisionLogId: result.log.id,
    reasonSummary: result.decision.reason_summary,
    reasonRaw: result.decision.detailed_reason,
    reasonTags: ["trend", "momentum", "risk_control"],
  });

  return NextResponse.json({
    decision: result.decision,
    blockedByRisk: result.blockedByRisk,
    blockReason: result.blockReason,
    executed: true,
    order,
  });
}
