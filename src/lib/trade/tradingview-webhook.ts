import { OrderAction, OrderSide, OrderStatus, Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { okxAdapter } from "@/lib/okx/adapter";
import type { OkxEnv, OkxOrderRequest } from "@/lib/okx/types";
import { DEMO_USER_EMAIL } from "@/lib/utils";

type TradingViewSignalKind =
  | "open_long"
  | "open_short"
  | "add_long"
  | "add_short"
  | "take_profit"
  | "stop_loss";

interface ParsedTradingViewSignal {
  kind: TradingViewSignalKind;
  symbol: string;
  instId: string;
  closePrice?: number;
  rawMessage: string;
}

interface TradingViewPayload {
  message: string;
  quantity?: number;
  size?: number;
}

interface FullPositionOrderPlan {
  quantity: number;
  leverage: number;
  referencePrice: number;
  stopLossPrice: number;
  availableUsdt: number;
  notionalUsdt: number;
  contractValue: number;
  lotSize: number;
  minSize: number;
  openBalancePct: number;
  stopLossPct: number;
}

function logTradingViewTerminal(event: string, payload: Record<string, unknown>) {
  console.info(`[tradingview-webhook] ${event}`, {
    timestamp: new Date().toISOString(),
    ...payload,
  });
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return "";

  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    return String(value);
  }
}

function describeError(error: unknown): Prisma.InputJsonObject {
  if (error instanceof AggregateError) {
    return {
      name: error.name,
      message: error.message,
      errors: error.errors.map((item) => describeError(item)),
    };
  }

  if (error instanceof Error) {
    const detail: Record<string, Prisma.InputJsonValue> = {
      name: error.name,
      message: error.message,
    };
    const maybeError = error as Error & {
      code?: unknown;
      errno?: unknown;
      syscall?: unknown;
      address?: unknown;
      port?: unknown;
      cause?: unknown;
      response?: { status?: unknown; data?: unknown };
    };

    if (maybeError.code) detail.code = String(maybeError.code);
    if (maybeError.errno) detail.errno = String(maybeError.errno);
    if (maybeError.syscall) detail.syscall = String(maybeError.syscall);
    if (maybeError.address) detail.address = String(maybeError.address);
    if (maybeError.port) detail.port = String(maybeError.port);
    if (maybeError.response) {
      detail.response = {
        status: typeof maybeError.response.status === "number" ? maybeError.response.status : null,
        data: toJsonValue(maybeError.response.data),
      };
    }
    if (maybeError.cause) detail.cause = describeError(maybeError.cause);

    return detail as Prisma.InputJsonObject;
  }

  return { message: String(error) };
}

function signalToJson(signal: ParsedTradingViewSignal): Prisma.InputJsonObject {
  return {
    kind: signal.kind,
    symbol: signal.symbol,
    instId: signal.instId,
    closePrice: signal.closePrice ?? null,
    rawMessage: signal.rawMessage,
  };
}

async function writeTradingViewLog(input: {
  userId?: string;
  level: "info" | "warn" | "error";
  message: string;
  payload?: Prisma.InputJsonValue;
}) {
  try {
    await prisma.systemLog.create({
      data: {
        userId: input.userId,
        level: input.level,
        category: "tradingview_webhook",
        message: input.message,
        payload: input.payload ?? Prisma.JsonNull,
      },
    });
  } catch (error) {
    console.error("[tradingview-webhook] failed to write system log", {
      error: error instanceof Error ? error.message : String(error),
      message: input.message,
    });
  }
}

function toNumberOrNull(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function clampTradingViewLeverage(value: unknown) {
  const parsed = toNumberOrNull(value) ?? 1;
  return Math.min(15, Math.max(1, Math.round(parsed)));
}

function clampPercent(value: unknown, fallback: number, min: number, max: number) {
  const parsed = toNumberOrNull(value) ?? fallback;
  return Math.min(max, Math.max(min, parsed));
}

function formatOkxNumber(value: number) {
  return Number(value.toFixed(12)).toString();
}

function floorToStep(value: number, step: number) {
  if (!Number.isFinite(step) || step <= 0) return value;
  return Math.floor(value / step) * step;
}

function extractAvailableUsdt(balance: unknown) {
  if (!Array.isArray(balance)) return null;
  const account = asRecord(balance[0]);
  if (!account) return null;

  const details = Array.isArray(account.details) ? account.details : [];
  const usdt = details
    .map(asRecord)
    .find((detail) => String(detail?.ccy || "").toUpperCase() === "USDT");
  const detail = usdt ?? asRecord(details[0]);

  return (
    toNumberOrNull(detail?.availEq) ??
    toNumberOrNull(detail?.availBal) ??
    toNumberOrNull(detail?.cashBal) ??
    toNumberOrNull(account.availEq) ??
    null
  );
}

function findInstrument(instruments: Array<Record<string, string>>, instId: string) {
  return instruments.find((instrument) => instrument.instId?.toUpperCase() === instId.toUpperCase()) ?? null;
}

async function buildFullPositionOrderPlan(input: {
  instId: string;
  side: OrderSide;
  env: OkxEnv;
  leverage: number;
  openBalancePct: number;
  stopLossPct: number;
  closePrice?: number;
}): Promise<FullPositionOrderPlan> {
  const [balance, ticker, instruments] = await Promise.all([
    okxAdapter.getBalance(input.env),
    okxAdapter.getTicker(input.instId),
    okxAdapter.getInstruments("SWAP"),
  ]);

  const availableUsdt = extractAvailableUsdt(balance);
  if (!availableUsdt || availableUsdt <= 0) {
    throw new Error("OKX USDT 可用余额不足，无法按全仓计算 TradingView 下单数量");
  }

  const tickerRow = asRecord(ticker);
  const liveReferencePrice =
    toNumberOrNull(tickerRow?.last) ??
    (input.side === "buy" ? toNumberOrNull(tickerRow?.askPx) : toNumberOrNull(tickerRow?.bidPx)) ??
    (input.side === "buy" ? toNumberOrNull(tickerRow?.bidPx) : toNumberOrNull(tickerRow?.askPx));
  const referencePrice = liveReferencePrice ?? input.closePrice;
  if (!referencePrice || referencePrice <= 0) {
    throw new Error("无法获取 TradingView 下单参考价格");
  }

  const instrument = findInstrument(instruments, input.instId);
  if (!instrument) {
    throw new Error(`OKX 未找到合约 ${input.instId}`);
  }

  const contractValue = toNumberOrNull(instrument.ctVal) ?? 1;
  const lotSize = toNumberOrNull(instrument.lotSz) ?? 1;
  const minSize = toNumberOrNull(instrument.minSz) ?? lotSize;
  if (contractValue <= 0 || lotSize <= 0 || minSize <= 0) {
    throw new Error(`OKX 合约 ${input.instId} 的下单规格异常`);
  }

  const allocatedUsdt = availableUsdt * (input.openBalancePct / 100);
  const notionalUsdt = allocatedUsdt * input.leverage;
  const rawSize = notionalUsdt / (referencePrice * contractValue);
  const quantity = floorToStep(rawSize, lotSize);
  if (!Number.isFinite(quantity) || quantity < minSize) {
    throw new Error(`按全仓计算后的数量 ${formatOkxNumber(quantity)} 小于 OKX 最小下单量 ${formatOkxNumber(minSize)}`);
  }

  return {
    quantity,
    leverage: input.leverage,
    referencePrice,
    stopLossPrice: input.side === "buy" ? referencePrice * (1 - input.stopLossPct / 100) : referencePrice * (1 + input.stopLossPct / 100),
    availableUsdt,
    notionalUsdt,
    contractValue,
    lotSize,
    minSize,
    openBalancePct: input.openBalancePct,
    stopLossPct: input.stopLossPct,
  };
}

function normalizeInstId(rawSymbol: string) {
  const cleaned = rawSymbol
    .trim()
    .replace(/^.*:/, "")
    .replace(/\.P$/i, "")
    .replace(/PERP$/i, "")
    .replace(/SWAP$/i, "")
    .replace(/[^a-z0-9-]/gi, "")
    .toUpperCase();

  if (cleaned.includes("-")) {
    return cleaned.endsWith("-SWAP") ? cleaned : `${cleaned}-SWAP`;
  }

  if (cleaned.endsWith("USDT")) {
    return `${cleaned.slice(0, -4)}-USDT-SWAP`;
  }

  if (cleaned.endsWith("USD")) {
    return `${cleaned.slice(0, -3)}-USD-SWAP`;
  }

  return `${cleaned}-USDT-SWAP`;
}

function parseBody(rawBody: string): TradingViewPayload {
  try {
    const json = JSON.parse(rawBody) as Record<string, unknown>;
    const message = String(json.message ?? json.text ?? json.alert ?? rawBody);
    return {
      message,
      quantity: toNumberOrNull(json.quantity) ?? undefined,
      size: toNumberOrNull(json.size) ?? undefined,
    };
  } catch {
    return { message: rawBody };
  }
}

function extractTradingViewSymbol(message: string) {
  const typeMatch = message.match(/(?:^|[^A-Z0-9])Type\s*[:：]\s*([A-Z0-9:._-]+)/i);
  if (typeMatch?.[1]) {
    return typeMatch[1];
  }

  return (message.match(/】\s*([A-Z0-9:._-]+)/i) ?? message.match(/^([A-Z0-9:._-]+)/i))?.[1];
}

export function parseTradingViewSignal(rawBody: string): TradingViewPayload & { signal: ParsedTradingViewSignal } {
  const payload = parseBody(rawBody);
  const message = payload.message.trim();
  const kind = (() => {
    if (message.includes("开多入场")) return "open_long";
    if (message.includes("开空入场")) return "open_short";
    if (message.includes("顺势加多")) return "add_long";
    if (message.includes("顺势加空")) return "add_short";
    if (message.includes("精准止盈")) return "take_profit";
    if (message.includes("触发止损")) return "stop_loss";
    return null;
  })();

  if (!kind) {
    throw new Error("无法识别 TradingView 信号类型");
  }

  const closeMatch = message.match(/@\s*([0-9]+(?:\.[0-9]+)?)/);
  const symbol = extractTradingViewSymbol(message);
  if (!symbol) {
    throw new Error("无法从 TradingView 消息中解析 Type/ticker");
  }

  return {
    ...payload,
    signal: {
      kind,
      symbol,
      instId: normalizeInstId(symbol),
      closePrice: closeMatch ? Number(closeMatch[1]) : undefined,
      rawMessage: message,
    },
  };
}

export async function recordTradingViewWebhookError(rawBody: string, error: unknown) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorDetail = describeError(error);
  console.error("[tradingview-webhook] failed", {
    timestamp: new Date().toISOString(),
    error: errorMessage,
    detail: errorDetail,
    rawBody,
  });

  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } }).catch(() => null);
  await writeTradingViewLog({
    userId: user?.id,
    level: "error",
    message: "TradingView webhook 处理失败",
    payload: {
      error: errorMessage,
      detail: errorDetail,
      rawBody,
    },
  });
}

function actionForSignal(kind: TradingViewSignalKind, closeSide?: OrderSide): OrderAction {
  if (kind === "open_long" || kind === "add_long") return "open_long";
  if (kind === "open_short" || kind === "add_short") return "open_short";
  return closeSide === "buy" ? "close_short" : "close_long";
}

function sideForSignal(kind: TradingViewSignalKind): OrderSide | null {
  if (kind === "open_long" || kind === "add_long") return "buy";
  if (kind === "open_short" || kind === "add_short") return "sell";
  return null;
}

function pickPositionToClose(positions: unknown, instId: string) {
  if (!Array.isArray(positions)) return null;
  const hit = positions.find((item) => {
    if (!item || typeof item !== "object") return false;
    return String((item as Record<string, unknown>).instId || "").toUpperCase() === instId;
  });
  if (!hit || typeof hit !== "object") return null;

  const row = hit as Record<string, unknown>;
  const pos = toNumberOrNull(row.pos) ?? 0;
  if (pos === 0) return null;

  const posSide = String(row.posSide || "").toLowerCase();
  let side: OrderSide = pos > 0 ? "sell" : "buy";
  if (posSide === "long") side = "sell";
  if (posSide === "short") side = "buy";

  return {
    side,
    size: Math.abs(pos),
    raw: row,
  };
}

function resolveOrderSize(payload: { quantity?: number; size?: number }) {
  const configured = toNumberOrNull(process.env.TRADINGVIEW_ORDER_SIZE);
  const size = payload.quantity ?? payload.size ?? configured ?? 0.01;
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error("TradingView 下单数量必须大于 0");
  }
  return size;
}

function planToJson(plan: FullPositionOrderPlan): Prisma.InputJsonObject {
  return {
    quantity: plan.quantity,
    leverage: plan.leverage,
    referencePrice: plan.referencePrice,
    openBalancePct: plan.openBalancePct,
    stopLossPct: plan.stopLossPct,
    stopLossPrice: plan.stopLossPrice,
    availableUsdt: plan.availableUsdt,
    notionalUsdt: plan.notionalUsdt,
    contractValue: plan.contractValue,
    lotSize: plan.lotSize,
    minSize: plan.minSize,
  };
}

function statusFromOkxOrderResult(orderResult: Record<string, string> | null): OrderStatus {
  if (!orderResult?.sCode || orderResult.sCode === "0") return "placed";
  return "rejected";
}

async function createTradeOrder(input: {
  userId: string;
  env: OkxEnv;
  instId: string;
  action: OrderAction;
  side: OrderSide;
  status: OrderStatus;
  quantity: number;
  price?: number;
  rawMessage: string;
  orderRequest?: Prisma.InputJsonValue;
  orderResponse?: Prisma.InputJsonValue;
  reasonTags: string[];
}) {
  return prisma.tradeOrder.create({
    data: {
      traceId: randomUUID(),
      executionId: randomUUID(),
      userId: input.userId,
      exchange: "okx",
      envType: input.env,
      symbol: input.instId,
      action: input.action,
      side: input.side,
      orderType: "market",
      status: input.status,
      triggerSource: "manual",
      price: input.price,
      quantity: input.quantity,
      aiDecisionSummary: "TradingView webhook signal",
      aiRawReason: input.rawMessage,
      reasonTags: ["tradingview", ...input.reasonTags],
      marketSnapshot: {
        symbol: input.instId,
        trigger: "tradingview_webhook",
        closePrice: input.price ?? null,
        rawMessage: input.rawMessage,
      },
      accountSnapshotBefore: input.orderRequest ?? {},
      accountSnapshotAfter: Prisma.JsonNull,
      orderResponse: input.orderResponse ?? {},
    },
  });
}

export async function executeTradingViewWebhook(rawBody: string) {
  const parsed = parseTradingViewSignal(rawBody);
  logTradingViewTerminal("received", {
    kind: parsed.signal.kind,
    symbol: parsed.signal.symbol,
    instId: parsed.signal.instId,
    closePrice: parsed.signal.closePrice ?? null,
    sizing: "configured_available_usdt_pct",
  });

  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) throw new Error("Demo user not found");

  await writeTradingViewLog({
    userId: user.id,
      level: "info",
      message: "收到 TradingView 信号",
      payload: {
        signal: signalToJson(parsed.signal),
      sizing: "configured_available_usdt_pct_for_open_signals",
      },
  });

  const [strategy, okxAccount] = await Promise.all([
    prisma.strategyConfig.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } }),
    prisma.exchangeAccount.findFirst({
      where: { userId: user.id, exchange: "okx", isDefault: true },
      orderBy: { updatedAt: "desc" },
    }),
  ]);

  if (!strategy) throw new Error("Strategy config missing");
  if (!strategy.enableTradingviewListener) {
    const side = sideForSignal(parsed.signal.kind) ?? "sell";
    const blocked = await createTradeOrder({
      userId: user.id,
      env: okxAccount?.envType || "demo",
      instId: parsed.signal.instId,
      action: actionForSignal(parsed.signal.kind, side),
      side,
      status: "blocked",
      quantity: 0,
      price: parsed.signal.closePrice,
      rawMessage: parsed.signal.rawMessage,
      orderResponse: { skipped: true, reason: "TradingView 监听未开启" },
      reasonTags: ["listener_disabled"],
    });
    const result = { parsed: parsed.signal, executed: false, order: blocked, reason: "TradingView 监听未开启" };
    logTradingViewTerminal("blocked", { reason: result.reason, orderId: blocked.id });
    await writeTradingViewLog({
      userId: user.id,
      level: "warn",
      message: "TradingView 信号未执行：监听未开启",
      payload: { signal: signalToJson(parsed.signal), orderId: blocked.id, status: blocked.status },
    });
    return result;
  }

  const env: OkxEnv = okxAccount?.envType || "demo";
  const openSide = sideForSignal(parsed.signal.kind);
  const tradingviewMode = strategy.tradingviewMode;
  const leverage = clampTradingViewLeverage(strategy.tradingviewLeverage);
  const openBalancePct = clampPercent(strategy.tradingviewOpenBalancePct, 100, 1, 100);
  const stopLossPct = clampPercent(strategy.tradingviewStopLossPct, 3, 0.1, 30);

  if (tradingviewMode === "analysis") {
    const side = openSide ?? "sell";
    const blocked = await createTradeOrder({
      userId: user.id,
      env,
      instId: parsed.signal.instId,
      action: actionForSignal(parsed.signal.kind, side),
      side,
      status: "blocked",
      quantity: 0,
      price: parsed.signal.closePrice,
      rawMessage: parsed.signal.rawMessage,
      orderResponse: { skipped: true, reason: "仅分析模式，不执行 TradingView 下单" },
      reasonTags: ["analysis_mode"],
    });
    const result = { parsed: parsed.signal, executed: false, order: blocked, reason: "仅分析模式" };
    logTradingViewTerminal("blocked", { reason: result.reason, mode: tradingviewMode, orderId: blocked.id });
    await writeTradingViewLog({
      userId: user.id,
      level: "warn",
      message: "TradingView 信号未执行：仅分析模式",
      payload: { signal: signalToJson(parsed.signal), mode: tradingviewMode, orderId: blocked.id, status: blocked.status },
    });
    return result;
  }

  if (tradingviewMode === "paper") {
    const side = openSide ?? "sell";
    const quantity = openSide ? resolveOrderSize(parsed) : resolveOrderSize(parsed);
    const order = await createTradeOrder({
      userId: user.id,
      env,
      instId: parsed.signal.instId,
      action: actionForSignal(parsed.signal.kind, side),
      side,
      status: "filled",
      quantity,
      price: parsed.signal.closePrice,
      rawMessage: parsed.signal.rawMessage,
      orderResponse: { mode: "paper", simulated: true },
      reasonTags: ["paper_trade", parsed.signal.kind],
    });
    const result = { parsed: parsed.signal, executed: true, order, paper: true };
    logTradingViewTerminal("paper-filled", {
      orderId: order.id,
      action: order.action,
      side: order.side,
      quantity: order.quantity,
      price: order.price ?? null,
    });
    await writeTradingViewLog({
      userId: user.id,
      level: "info",
      message: "TradingView 信号已触发模拟成交",
      payload: {
        signal: signalToJson(parsed.signal),
        mode: tradingviewMode,
        orderId: order.id,
        action: order.action,
        side: order.side,
        quantity: order.quantity,
        leverage,
        openBalancePct: openSide ? openBalancePct : null,
        stopLossPct: openSide ? stopLossPct : null,
        status: order.status,
      },
    });
    return result;
  }

  let orderPayload: OkxOrderRequest;
  let action: OrderAction;
  let openPlan: FullPositionOrderPlan | null = null;

  if (openSide) {
    openPlan = await buildFullPositionOrderPlan({
      instId: parsed.signal.instId,
      side: openSide,
      env,
      leverage,
      openBalancePct,
      stopLossPct,
      closePrice: parsed.signal.closePrice,
    });
    action = actionForSignal(parsed.signal.kind, openSide);
    orderPayload = {
      instId: parsed.signal.instId,
      tdMode: "cross",
      side: openSide,
      ordType: "market",
      sz: formatOkxNumber(openPlan.quantity),
      attachAlgoOrds: [
        {
          slTriggerPx: formatOkxNumber(openPlan.stopLossPrice),
          slOrdPx: "-1",
          slTriggerPxType: "last",
        },
      ],
    };
    logTradingViewTerminal("open-plan", {
      instId: parsed.signal.instId,
      side: openSide,
      quantity: orderPayload.sz,
      leverage,
      openBalancePct,
      availableUsdt: openPlan.availableUsdt,
      referencePrice: openPlan.referencePrice,
      stopLossPrice: openPlan.stopLossPrice,
      stopLossPct,
    });
  } else {
    const positions = await okxAdapter.getPositions("SWAP", env);
    const closePlan = pickPositionToClose(positions, parsed.signal.instId);
    if (!closePlan) {
      const blocked = await createTradeOrder({
        userId: user.id,
        env,
        instId: parsed.signal.instId,
        action: "close_long",
        side: "sell",
        status: "blocked",
        quantity: 0,
        price: parsed.signal.closePrice,
        rawMessage: parsed.signal.rawMessage,
        orderResponse: { skipped: true, reason: "未找到可平仓仓位" },
        reasonTags: [parsed.signal.kind, "close_without_position"],
      });
      const result = { parsed: parsed.signal, executed: false, order: blocked, reason: "未找到可平仓仓位" };
      logTradingViewTerminal("blocked", { reason: result.reason, orderId: blocked.id });
      await writeTradingViewLog({
        userId: user.id,
        level: "warn",
        message: "TradingView 平仓信号未执行：未找到可平仓仓位",
        payload: { signal: signalToJson(parsed.signal), orderId: blocked.id, status: blocked.status },
      });
      return result;
    }
    action = actionForSignal(parsed.signal.kind, closePlan.side);
    orderPayload = {
      instId: parsed.signal.instId,
      tdMode: "cross",
      side: closePlan.side,
      ordType: "market",
      sz: String(closePlan.size),
      reduceOnly: true,
    };
  }

  if (openPlan) {
    try {
      logTradingViewTerminal("set-leverage-start", {
        instId: parsed.signal.instId,
        leverage,
        env,
      });
      await okxAdapter.setLeverage(parsed.signal.instId, leverage, "cross", env);
      logTradingViewTerminal("set-leverage-success", {
        instId: parsed.signal.instId,
        leverage,
        env,
      });
    } catch (error) {
      logTradingViewTerminal("set-leverage-failed", {
        instId: parsed.signal.instId,
        leverage,
        env,
        error: error instanceof Error ? error.message : String(error),
        detail: describeError(error),
      });
      throw error;
    }
  }

  let orderResult: Awaited<ReturnType<typeof okxAdapter.placeOrder>>;
  try {
    logTradingViewTerminal("place-order-start", {
      instId: orderPayload.instId,
      side: orderPayload.side,
      quantity: orderPayload.sz,
      reduceOnly: orderPayload.reduceOnly ?? false,
      env,
    });
    orderResult = await okxAdapter.placeOrder(orderPayload, env);
  } catch (error) {
    logTradingViewTerminal("place-order-failed", {
      instId: orderPayload.instId,
      side: orderPayload.side,
      quantity: orderPayload.sz,
      reduceOnly: orderPayload.reduceOnly ?? false,
      env,
      error: error instanceof Error ? error.message : String(error),
      detail: describeError(error),
    });
    throw error;
  }
  const orderStatus = statusFromOkxOrderResult(orderResult);
  const order = await createTradeOrder({
    userId: user.id,
    env,
    instId: parsed.signal.instId,
    action,
    side: orderPayload.side,
    status: orderStatus,
    quantity: Number(orderPayload.sz),
    price: parsed.signal.closePrice,
    rawMessage: parsed.signal.rawMessage,
    orderRequest: orderPayload as unknown as Prisma.InputJsonValue,
    orderResponse: orderResult as Prisma.InputJsonValue,
    reasonTags: [parsed.signal.kind],
  });

  const result = { parsed: parsed.signal, executed: true, order, okx: orderResult };
  logTradingViewTerminal(orderStatus === "placed" ? "okx-order-placed" : "okx-order-rejected", {
    orderId: order.id,
    action: order.action,
    side: order.side,
    quantity: order.quantity,
    env,
    okxOrderId: orderResult?.ordId ?? null,
    okxStatusCode: orderResult?.sCode ?? null,
    okxStatusMessage: orderResult?.sMsg ?? null,
    leverage: openPlan?.leverage ?? null,
    stopLossPrice: openPlan?.stopLossPrice ?? null,
  });
  await writeTradingViewLog({
    userId: user.id,
    level: "info",
    message: orderStatus === "placed" ? "TradingView 信号已触发 OKX 下单" : "TradingView 信号已触发但 OKX 拒单",
    payload: {
      signal: signalToJson(parsed.signal),
      env,
      mode: tradingviewMode,
      orderId: order.id,
      okxOrderId: orderResult?.ordId ?? null,
      okxStatusCode: orderResult?.sCode ?? null,
      okxStatusMessage: orderResult?.sMsg ?? null,
      action: order.action,
      side: order.side,
      quantity: order.quantity,
      sizing: openPlan ? planToJson(openPlan) : null,
      status: order.status,
    },
  });

  return result;
}
