import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { runLlmDecision } from "@/lib/llm/client";
import { aiDecisionSchema } from "@/lib/llm/schema";
import { logger } from "@/lib/logger";
import { okxAdapter } from "@/lib/okx/adapter";
import { runRiskChecks } from "@/lib/risk/engine";
import { DEMO_USER_EMAIL } from "@/lib/utils";

interface RunDecisionParams {
  symbol: string;
  timeframe: string;
}

export async function runDecisionEngine(params: RunDecisionParams) {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) throw new Error("User not found");

  const [llm, strategy, risk] = await Promise.all([
    prisma.llmProviderConfig.findFirst({ where: { userId: user.id, isDefault: true } }),
    prisma.strategyConfig.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } }),
    prisma.riskConfig.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } }),
  ]);

  if (!llm || !strategy || !risk) {
    throw new Error("LLM/策略/风控配置缺失，请先完成初始化");
  }

  const [ticker, candles, positions, pendingOrders] = await Promise.all([
    okxAdapter.getTicker(params.symbol).catch(() => null),
    okxAdapter.getCandles(params.symbol, params.timeframe, 120).catch(() => []),
    okxAdapter.getPositions("SWAP").catch(() => []),
    okxAdapter.getPendingOrders("SWAP").catch(() => []),
  ]);

  const marketSnapshot = await prisma.marketSnapshot.create({
    data: {
      symbol: params.symbol,
      timeframe: params.timeframe,
      candleData: candles,
      indicators: {
        ma: null,
        ema: null,
        macd: null,
        rsi: null,
        atr: null,
        bollinger: null,
        volume: null,
      },
      marketSummary: ticker ? `最新价格: ${(ticker as Record<string, string>).last || "unknown"}` : "行情获取失败，使用回退数据",
    },
  });

  const promptPayload = {
    symbol: params.symbol,
    timeframe: params.timeframe,
    candles,
    indicators: marketSnapshot.indicators,
    currentPosition: positions,
    accountState: { equity: 10000, available: 8000 },
    pendingOrders,
    recentTrades: await prisma.tradeOrder.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    userTradingPrompt: llm.tradingPrompt,
    riskConstraints: risk,
    marketSummary: marketSnapshot.marketSummary,
  };
  const marketContextJson = JSON.parse(JSON.stringify(promptPayload)) as Prisma.InputJsonValue;

  const now = Date.now();
  let blockedByRisk = false;
  let blockReason: string | null = null;

  try {
    const decision = await runLlmDecision(
      [
        { role: "system", content: llm.systemPrompt },
        {
          role: "user",
          content: `${llm.tradingPrompt}\n\n请基于如下上下文严格输出 JSON:\n${JSON.stringify(promptPayload)}`,
        },
      ],
      {
        provider: llm.provider,
        model: llm.model,
        apiKey: process.env.LLM_API_KEY || "",
        baseUrl: llm.baseUrl,
        temperature: llm.temperature,
        maxTokens: llm.maxTokens,
      },
    );

    const validated = aiDecisionSchema.parse(decision);
    const expectedOrderValue = (ticker ? Number((ticker as Record<string, string>).last || 0) : 0) * (validated.suggested_position_size_pct / 100);

    const riskResult = runRiskChecks(risk, {
      symbol: params.symbol,
      expectedOrderValue,
      accountEquity: 10000,
      dailyPnl: -120,
      drawdownPct: 6,
      consecutiveLosses: 1,
      volatilityPct: 2,
    });

    blockedByRisk = !riskResult.pass;
    blockReason = blockedByRisk ? riskResult.reasons.join("；") : null;

    const log = await prisma.aiDecisionLog.create({
      data: {
        userId: user.id,
        modelName: llm.model,
        provider: llm.provider,
        inputPrompt: llm.tradingPrompt,
        marketContext: marketContextJson,
        modelOutputJson: validated,
        finalAction: validated.action === "buy" ? "buy" : validated.action === "sell" ? "sell" : "hold",
        confidence: validated.confidence,
        blockedByRisk,
        blockReason,
        latencyMs: Date.now() - now,
        tokenUsage: Prisma.JsonNull,
        marketSnapshotId: marketSnapshot.id,
      },
    });

    return {
      log,
      decision: validated,
      blockedByRisk,
      blockReason,
    };
  } catch (error) {
    logger.error({ error }, "runDecisionEngine error");
    const failLog = await prisma.aiDecisionLog.create({
      data: {
        userId: user.id,
        modelName: llm.model,
        provider: llm.provider,
        inputPrompt: llm.tradingPrompt,
        marketContext: marketContextJson,
        modelOutputJson: {},
        finalAction: "hold",
        confidence: 0,
        blockedByRisk: true,
        blockReason: "模型调用失败",
        latencyMs: Date.now() - now,
        errorMessage: error instanceof Error ? error.message : "unknown",
        marketSnapshotId: marketSnapshot.id,
      },
    });

    return {
      log: failLog,
      decision: null,
      blockedByRisk: true,
      blockReason: "模型调用失败",
    };
  }
}
