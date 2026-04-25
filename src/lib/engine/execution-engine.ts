import { OrderSide, OrderStatus, Prisma, TriggerSource } from "@prisma/client";
import { prisma } from "@/lib/db";
import { okxAdapter } from "@/lib/okx/adapter";
import { DEMO_USER_EMAIL } from "@/lib/utils";

interface ExecuteOrderInput {
  symbol: string;
  side: OrderSide;
  quantity: number;
  price?: number;
  source: TriggerSource;
  aiDecisionLogId?: string;
  reasonSummary?: string;
  reasonRaw?: string;
  reasonTags?: string[];
}

export async function executeOrder(input: ExecuteOrderInput) {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) throw new Error("Demo user not found");

  const strategy = await prisma.strategyConfig.findFirst({ where: { userId: user.id } });
  if (!strategy) throw new Error("Strategy config missing");

  const mode = strategy.mode;
  if (mode === "analysis") {
    const order = await prisma.tradeOrder.create({
      data: {
        userId: user.id,
        aiDecisionLogId: input.aiDecisionLogId,
        exchange: "okx",
        envType: "demo",
        symbol: input.symbol,
        action: input.side === "buy" ? "buy" : "sell",
        side: input.side,
        orderType: input.price ? "limit" : "market",
        status: OrderStatus.blocked,
        triggerSource: input.source,
        price: input.price,
        quantity: input.quantity,
        aiDecisionSummary: input.reasonSummary,
        aiRawReason: input.reasonRaw,
        reasonTags: input.reasonTags || [],
        marketSnapshot: { symbol: input.symbol },
        accountSnapshotBefore: { mode: "analysis" },
        accountSnapshotAfter: { mode: "analysis" },
        orderResponse: { message: "仅分析模式，不执行下单" },
      },
    });

    return order;
  }

  if (mode === "paper") {
    const simulatedPrice = input.price || 65000 + Math.random() * 1000;
    const order = await prisma.tradeOrder.create({
      data: {
        userId: user.id,
        aiDecisionLogId: input.aiDecisionLogId,
        exchange: "okx",
        envType: "demo",
        symbol: input.symbol,
        action: input.side === "buy" ? "buy" : "sell",
        side: input.side,
        orderType: input.price ? "limit" : "market",
        status: OrderStatus.filled,
        triggerSource: input.source,
        price: simulatedPrice,
        quantity: input.quantity,
        fee: simulatedPrice * input.quantity * 0.0005,
        estimatedSlippage: 1.2,
        aiDecisionSummary: input.reasonSummary,
        aiRawReason: input.reasonRaw,
        reasonTags: input.reasonTags || ["paper_trade"],
        marketSnapshot: { symbol: input.symbol },
        accountSnapshotBefore: { equity: 10000, available: 9000 },
        accountSnapshotAfter: { equity: 10002, available: 8998 },
        orderResponse: { mode: "paper", simulated: true },
      },
    });

    await prisma.tradeFill.create({
      data: {
        userId: user.id,
        tradeOrderId: order.id,
        fillPrice: simulatedPrice,
        fillSize: input.quantity,
        fee: simulatedPrice * input.quantity * 0.0005,
        liquidity: "T",
      },
    });

    return order;
  }

  const result = await okxAdapter.placeOrder({
    instId: input.symbol,
    tdMode: "cross",
    side: input.side,
    ordType: input.price ? "limit" : "market",
    sz: `${input.quantity}`,
    ...(input.price ? { px: `${input.price}` } : {}),
  }, "live");

  return prisma.tradeOrder.create({
    data: {
      userId: user.id,
      aiDecisionLogId: input.aiDecisionLogId,
      exchange: "okx",
      envType: "live",
      symbol: input.symbol,
      action: input.side === "buy" ? "buy" : "sell",
      side: input.side,
      orderType: input.price ? "limit" : "market",
      status: OrderStatus.placed,
      triggerSource: input.source,
      price: input.price,
      quantity: input.quantity,
      aiDecisionSummary: input.reasonSummary,
      aiRawReason: input.reasonRaw,
      reasonTags: input.reasonTags || [],
      marketSnapshot: { symbol: input.symbol },
      accountSnapshotBefore: { mode: "live" },
      accountSnapshotAfter: Prisma.JsonNull,
      orderResponse: result || {},
    },
  });
}
