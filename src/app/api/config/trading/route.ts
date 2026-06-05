import { NextRequest, NextResponse } from "next/server";
import { TradeMode } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { DEMO_USER_EMAIL } from "@/lib/utils";
import { syncDefaultUserConfig } from "@/lib/config/default-user-config";

const tradingSchema = z.object({
  symbols: z.array(z.string()).min(1),
  timeframe: z.string(),
  leverage: z.number().min(1).max(100),
  maxPositionPct: z.number().min(1).max(100),
  perTradeRiskPct: z.number().min(0.1).max(10),
  stopLossPct: z.number().min(0.1).max(30),
  takeProfitPct: z.number().min(0.1).max(100),
  maxDrawdownPct: z.number().min(1).max(80),
  mode: z.nativeEnum(TradeMode),
  autoTradingEnabled: z.boolean(),
  enableAiListener: z.boolean().default(true),
  enableTradingviewListener: z.boolean().default(false),
});

export async function GET() {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ data: null });

  const strategy = await prisma.strategyConfig.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } });
  const risk = await prisma.riskConfig.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } });

  return NextResponse.json({ data: { strategy, risk } });
}

export async function POST(request: NextRequest) {
  const payload = tradingSchema.parse(await request.json());
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const strategy = await prisma.strategyConfig.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } });

  const saved = strategy
    ? await prisma.strategyConfig.update({
        where: { id: strategy.id },
        data: payload,
      })
    : await prisma.strategyConfig.create({
        data: {
          userId: user.id,
          name: "默认策略",
          ...payload,
        },
      });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "update_strategy",
      target: "strategy_config",
      before: strategy || {},
      after: saved,
    },
  });

  await syncDefaultUserConfig(user.id);

  return NextResponse.json({ id: saved.id });
}
