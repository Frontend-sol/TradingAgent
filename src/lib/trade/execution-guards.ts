import { randomUUID } from "crypto";
import type { OrderAction, OrderStatus } from "@prisma/client";

export type ExecutionTrace = {
  traceId: string;
  executionId: string;
  runnerSymbol: string;
};

export type RecentOrderLike = {
  id?: string;
  symbol: string;
  action: OrderAction;
  status: OrderStatus;
  createdAt: Date;
};

export const POST_CLOSE_COOLDOWN_MS = 15 * 60 * 1000;
export const MIN_POSITION_HOLD_MS = 15 * 60 * 1000;

const ACTIVE_ORDER_STATUSES = new Set<OrderStatus>(["pending", "placed", "partially_filled", "filled"]);
const CLOSE_ACTIONS = new Set<OrderAction>(["close_long", "close_short"]);
const OPEN_ACTIONS = new Set<OrderAction>(["buy", "sell", "open_long", "open_short"]);

export function createExecutionTrace(runnerSymbol: string): ExecutionTrace {
  return {
    traceId: randomUUID(),
    executionId: randomUUID(),
    runnerSymbol,
  };
}

export function normalizePerpInstId(symbol: string) {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) return normalized;
  if (normalized.endsWith("-USDT-SWAP")) return normalized;
  if (normalized.endsWith("-SWAP")) return normalized;
  if (normalized.includes("-")) return `${normalized}-SWAP`;
  return `${normalized}-USDT-SWAP`;
}

export function getCoinFromInstId(instId: string) {
  return normalizePerpInstId(instId).split("-")[0]?.toLowerCase() || "";
}

export function assertDecisionSymbolMatchesRunner(runnerSymbol: string, decisionSymbol: string) {
  const normalizedRunner = normalizePerpInstId(runnerSymbol);
  const normalizedDecision = normalizePerpInstId(decisionSymbol);
  if (normalizedRunner === normalizedDecision) return null;
  return `LLM 决策目标 ${normalizedDecision} 与当前执行 symbol ${normalizedRunner} 不一致，已阻断以防 symbol/price 串线`;
}

export function getReferencePriceForSymbol(context: Record<string, unknown>, instId: string) {
  const coin = getCoinFromInstId(instId);
  const aliasPrice = Number(context[`${coin}_price`]);
  if (Number.isFinite(aliasPrice) && aliasPrice > 0) return aliasPrice;

  const currentSymbol = normalizePerpInstId(String(context.symbol || ""));
  const currentPrice = Number(context.current_price);
  if (currentSymbol === normalizePerpInstId(instId) && Number.isFinite(currentPrice) && currentPrice > 0) {
    return currentPrice;
  }

  return null;
}

export function calculateDirectionalSlippage(input: {
  side: "buy" | "sell";
  executedPrice: number | null;
  referencePrice: number | null;
}) {
  if (input.executedPrice == null || input.referencePrice == null || input.referencePrice <= 0) {
    return { slippage: null, slippageBps: null };
  }

  const raw = input.side === "buy"
    ? input.executedPrice - input.referencePrice
    : input.referencePrice - input.executedPrice;

  return {
    slippage: raw,
    slippageBps: (raw / input.referencePrice) * 10000,
  };
}

export function classifyOkxOrderStatus(orderState: unknown, hasOrderId: boolean): OrderStatus {
  const state = String(orderState || "").toLowerCase();
  if (state === "filled") return "filled";
  if (state === "partially_filled" || state === "partially-filled") return "partially_filled";
  if (state === "canceled" || state === "cancelled") return "canceled";
  if (state === "rejected") return "rejected";
  return hasOrderId ? "placed" : "rejected";
}

export function findDuplicateOpenBlock(input: {
  symbol: string;
  action: "buy" | "sell";
  positionQuantity: number;
  recentOrders: RecentOrderLike[];
  now?: Date;
}) {
  if (input.positionQuantity !== 0) {
    return "已有同标的持仓，禁止重复开仓";
  }

  const nowMs = (input.now || new Date()).getTime();
  const recent = input.recentOrders.find((order) => {
    return order.symbol === input.symbol
      && order.action === input.action
      && ACTIVE_ORDER_STATUSES.has(order.status)
      && nowMs - order.createdAt.getTime() <= 3 * 60 * 1000;
  });

  return recent ? `最近 3 分钟已有 ${input.action} 订单 ${recent.id || ""}，禁止重复下单`.trim() : null;
}

export function findPostCloseCooldownBlock(input: {
  symbol: string;
  action: OrderAction;
  recentOrders: RecentOrderLike[];
  now?: Date;
  cooldownMs?: number;
}) {
  if (!OPEN_ACTIONS.has(input.action)) return null;
  const nowMs = (input.now || new Date()).getTime();
  const cooldownMs = input.cooldownMs ?? POST_CLOSE_COOLDOWN_MS;
  const recentClose = input.recentOrders.find((order) => {
    return order.symbol === input.symbol
      && CLOSE_ACTIONS.has(order.action)
      && ACTIVE_ORDER_STATUSES.has(order.status)
      && nowMs - order.createdAt.getTime() <= cooldownMs;
  });

  return recentClose ? `刚平仓 ${Math.round(cooldownMs / 60000)} 分钟冷却期内，禁止重新开仓` : null;
}

export function findMinHoldCloseBlock(input: {
  symbol: string;
  action: OrderAction;
  recentOrders: RecentOrderLike[];
  now?: Date;
  minHoldMs?: number;
}) {
  if (!CLOSE_ACTIONS.has(input.action)) return null;
  const nowMs = (input.now || new Date()).getTime();
  const minHoldMs = input.minHoldMs ?? MIN_POSITION_HOLD_MS;
  const recentOpen = input.recentOrders.find((order) => {
    return order.symbol === input.symbol
      && OPEN_ACTIONS.has(order.action)
      && ACTIVE_ORDER_STATUSES.has(order.status)
      && nowMs - order.createdAt.getTime() <= minHoldMs;
  });

  return recentOpen ? `最小持仓 ${Math.round(minHoldMs / 60000)} 分钟内，禁止因普通信号平仓` : null;
}
