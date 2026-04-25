import { NextRequest, NextResponse } from "next/server";
import { TradeMode } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { DEMO_USER_EMAIL } from "@/lib/utils";

const barEnum = z.enum(["15s", "1m", "3m", "5m", "15m", "1h"]);

const schema = z.object({
  timeframe: barEnum,
  minLeverage: z.number().min(1).max(100),
  maxLeverage: z.number().min(1).max(100),
  symbols: z.array(z.string()).min(1),
  autoTradingEnabled: z.boolean(),
  llmPromptTemplate: z.string().min(1),
});

const DEFAULT_TEMPLATE = [
  "你是交易决策引擎，请严格输出 JSON，不要输出额外文本。",
  "symbol: {{symbol}}",
  "time: {{timestamp}}",
  "balance: {{balance}}",
  "market: {{market_data}}",
  "返回格式: {\"action\":\"buy|sell|hold\",\"size\":1,\"leverage\":3,\"reason\":\"...\"}",
].join("\n");

export async function GET() {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ data: null });

  const strategy = await prisma.strategyConfig.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } });
  if (!strategy) {
    return NextResponse.json({
      data: {
        timeframe: "5m",
        minLeverage: 1,
        maxLeverage: 3,
        symbols: ["BTC-USDT"],
        autoTradingEnabled: false,
        llmPromptTemplate: DEFAULT_TEMPLATE,
      },
    });
  }

  const normalizedSymbols =
    strategy.symbols?.length > 0
      ? strategy.symbols.map((item) => item.replace(/-SWAP$/i, ""))
      : ["BTC-USDT"];

  return NextResponse.json({
    data: {
      timeframe: (strategy.timeframe as "15s" | "1m" | "3m" | "5m" | "15m" | "1h") || "5m",
      minLeverage: strategy.minLeverage || 1,
      maxLeverage: strategy.maxLeverage || 3,
      symbols: normalizedSymbols,
      autoTradingEnabled: strategy.autoTradingEnabled,
      llmPromptTemplate: strategy.llmPromptTemplate || DEFAULT_TEMPLATE,
    },
  });
}

export async function POST(request: NextRequest) {
  const payload = schema.parse(await request.json());
  if (payload.minLeverage > payload.maxLeverage) {
    return NextResponse.json({ error: "最小杠杆不能大于最大杠杆" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const strategy = await prisma.strategyConfig.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } });

  const data = {
    timeframe: payload.timeframe,
    minLeverage: payload.minLeverage,
    maxLeverage: payload.maxLeverage,
    leverage: (payload.minLeverage + payload.maxLeverage) / 2,
    symbols: payload.symbols,
    autoTradingEnabled: payload.autoTradingEnabled,
    llmPromptTemplate: payload.llmPromptTemplate,
    mode: TradeMode.paper,
  };

  const saved = strategy
    ? await prisma.strategyConfig.update({
        where: { id: strategy.id },
        data,
      })
    : await prisma.strategyConfig.create({
        data: {
          userId: user.id,
          name: "自动交易Demo",
          exchange: "okx",
          maxPositionPct: 20,
          perTradeRiskPct: 1,
          stopLossPct: 1.5,
          takeProfitPct: 3,
          maxDrawdownPct: 15,
          ...data,
        },
      });

  return NextResponse.json({ data: saved });
}
