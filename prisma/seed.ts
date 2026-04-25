import { PrismaClient, TradeMode } from "@prisma/client";

const prisma = new PrismaClient();

const defaultPrompt = `你是一名严格的加密资产量化交易分析师。
你的任务不是预测市场，而是在给定市场数据、账户状态、当前仓位、最近交易记录和风险约束的前提下，输出一个审慎、可执行、可审计的交易决策。
请严格只返回 JSON，不要输出任何额外解释。
你必须优先考虑风险控制，其次才是收益机会。
如果没有高质量机会，请输出 hold。
如果信号冲突、波动过高、风险回报比不合适，也应输出 hold。
你的决策必须给出：
1. 动作
2. 置信度
3. 简要理由
4. 详细理由
5. 建议仓位
6. 止损止盈
7. 风险等级
8. 逻辑失效条件
9. 关键技术信号拆解`;

async function main() {
  const user = await prisma.user.upsert({
    where: { email: "demo@autotrading.local" },
    update: {},
    create: {
      email: "demo@autotrading.local",
      name: "Demo Trader",
    },
  });

  await prisma.exchangeAccount.upsert({
    where: { id: "demo-exchange-account" },
    update: {},
    create: {
      id: "demo-exchange-account",
      userId: user.id,
      exchange: "okx",
      envType: "demo",
      label: "OKX Demo",
      apiKeyMasked: "okx_demo_****",
      encryptedApiKey: "encrypted:demo_api_key",
      encryptedSecret: "encrypted:demo_secret",
      encryptedPassphrase: "encrypted:demo_passphrase",
      readOnly: true,
      enableAutoTrading: false,
      isDefault: true,
    },
  });

  await prisma.tradingPromptConfig.upsert({
    where: { id: "default-prompt" },
    update: {},
    create: {
      id: "default-prompt",
      userId: user.id,
      name: "默认审慎量化提示词",
      content: defaultPrompt,
      isDefault: true,
    },
  });

  await prisma.llmProviderConfig.upsert({
    where: { id: "default-llm-config" },
    update: {},
    create: {
      id: "default-llm-config",
      userId: user.id,
      provider: "openai",
      model: "gpt-4o-mini",
      apiKeyMasked: "sk-****",
      encryptedApiKey: "encrypted:llm_key",
      baseUrl: "https://api.openai.com/v1",
      temperature: 0.2,
      maxTokens: 800,
      systemPrompt: "You are a strict crypto quantitative analyst.",
      tradingPrompt: defaultPrompt,
      decisionSchema: {
        action: "buy | sell | hold | close_long | close_short | open_long | open_short",
        confidence: "0-100",
        reason_summary: "string",
      },
      secondaryConfirmation: false,
      multiModelVoting: false,
      structuredReasonOutput: true,
      isDefault: true,
    },
  });

  await prisma.strategyConfig.upsert({
    where: { id: "default-strategy" },
    update: {},
    create: {
      id: "default-strategy",
      userId: user.id,
      name: "BTC趋势跟随基础策略",
      symbols: ["BTC-USDT-SWAP", "ETH-USDT-SWAP"],
      timeframe: "15m",
      leverage: 2,
      maxPositionPct: 20,
      perTradeRiskPct: 1,
      stopLossPct: 1.5,
      takeProfitPct: 3,
      maxDrawdownPct: 12,
      mode: TradeMode.analysis,
      autoTradingEnabled: false,
    },
  });

  await prisma.riskConfig.upsert({
    where: { id: "default-risk" },
    update: {},
    create: {
      id: "default-risk",
      userId: user.id,
      maxPositionValue: 20000,
      maxSingleOrderValue: 5000,
      maxDailyLoss: 1000,
      maxDrawdownPct: 12,
      maxConsecutiveLosses: 3,
      stopOnModelError: true,
      stopOnApiError: true,
      highVolatilityPause: true,
      volatilityThreshold: 4,
      whitelistSymbols: ["BTC-USDT-SWAP", "ETH-USDT-SWAP"],
      blacklistSymbols: [],
      killSwitchEnabled: false,
    },
  });

  const market = await prisma.marketSnapshot.create({
    data: {
      symbol: "BTC-USDT-SWAP",
      timeframe: "15m",
      candleData: [{ t: Date.now(), o: 66000, h: 66300, l: 65800, c: 66220, v: 1234 }],
      indicators: { rsi: 56, emaFast: 66120, emaSlow: 65880, atr: 320 },
      marketSummary: "震荡偏强，量能温和放大",
    },
  });

  const decision = await prisma.aiDecisionLog.create({
    data: {
      userId: user.id,
      modelName: "gpt-4o-mini",
      provider: "openai",
      inputPrompt: "demo prompt",
      marketContext: { symbol: "BTC-USDT-SWAP", timeframe: "15m" },
      modelOutputJson: {
        action: "hold",
        confidence: 58,
        reason_summary: "信号未形成共振",
      },
      finalAction: "hold",
      confidence: 58,
      blockedByRisk: false,
      marketSnapshotId: market.id,
    },
  });

  await prisma.tradeOrder.create({
    data: {
      userId: user.id,
      aiDecisionLogId: decision.id,
      exchange: "okx",
      envType: "demo",
      symbol: "BTC-USDT-SWAP",
      action: "buy",
      side: "buy",
      orderType: "market",
      status: "filled",
      triggerSource: "manual",
      price: 66220,
      quantity: 0.01,
      fee: 0.2,
      estimatedSlippage: 2.3,
      aiDecisionSummary: "信号未形成共振，人工试单",
      aiRawReason: "演示订单",
      reasonTags: ["trend", "risk_control"],
      marketSnapshot: { symbol: "BTC-USDT-SWAP", close: 66220 },
      accountSnapshotBefore: { equity: 10000, available: 9600 },
      accountSnapshotAfter: { equity: 10005, available: 9550 },
      orderResponse: { ordId: "demo-ord-1" },
    },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
