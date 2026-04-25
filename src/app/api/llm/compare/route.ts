import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const schema = z.object({
  symbol: z.string().default("BTC-USDT-SWAP"),
  models: z.array(z.string()).min(1),
});

export async function POST(request: NextRequest) {
  const payload = schema.parse(await request.json());

  const result = payload.models.map((model, index) => ({
    model,
    action: ["buy", "sell", "hold"][index % 3],
    confidence: Math.floor(55 + Math.random() * 40),
    reason: `${model} 对 ${payload.symbol} 给出模拟决策`,
  }));

  return NextResponse.json({
    symbol: payload.symbol,
    result,
    winner: result.sort((a, b) => b.confidence - a.confidence)[0],
  });
}
