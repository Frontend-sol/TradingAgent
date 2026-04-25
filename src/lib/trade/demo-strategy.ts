import axios from "axios";
import { Prisma } from "@prisma/client";
import type { OrderAction, OrderSide, OrderStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { DEMO_USER_EMAIL } from "@/lib/utils";
import { okxAdapter } from "@/lib/okx/adapter";
import type { OkxEnv } from "@/lib/okx/types";
import { logOutboundRequestError, logOutboundRequestStart, logOutboundRequestSuccess } from "@/lib/http-log";
import {
  assertDecisionSymbolMatchesRunner,
  calculateDirectionalSlippage,
  classifyOkxOrderStatus,
  createExecutionTrace,
  findDuplicateOpenBlock,
  findMinHoldCloseBlock,
  findPostCloseCooldownBlock,
  getReferencePriceForSymbol,
  normalizePerpInstId,
  type RecentOrderLike,
} from "@/lib/trade/execution-guards";

const DEFAULT_PROMPT_TEMPLATE = [
  "你是交易决策引擎，请严格输出 JSON，不要输出额外文本。",
  "symbol: {{symbol}}",
  "time: {{timestamp}}",
  "balance: {{balance}}",
  "market: {{market_data}}",
  "返回格式: {\"action\":\"buy|sell|hold\",\"size\":1,\"leverage\":3,\"reason\":\"...\"}",
].join("\n");

interface DemoDecision {
  action: "buy" | "sell" | "hold" | "close";
  size: number;
  leverage: number;
  reason: string;
  targetInstId?: string;
  confidence: number;
  raw: Record<string, unknown>;
}

type ParsedDecision = DemoDecision & {
  validationErrors: string[];
};

type TemplateContext = Record<string, unknown>;

type ResolveContextInput = {
  template: string;
  instId: string;
  timeframe: string;
  bar: string;
  env: OkxEnv;
  userId: string;
  startedAt?: Date;
  stopLossPct?: number;
  takeProfitPct?: number;
};

type LlmRuntimeConfig = {
  provider: string;
  encryptedApiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
};

type CandleNormalized = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  confirmed: boolean;
};

type ResolvedTemplateContext = {
  context: TemplateContext;
  requestedVariables: string[];
  unknownVariables: string[];
  okxEndpoints: string[];
};

const BUILTIN_VARIABLES = new Set([
  "symbol",
  "coin",
  "contract",
  "exchange",
  "asset_universe",
  "decision_frequency",
  "timestamp",
  "timeframe",
  "market_data",
  "market_data_raw",
  "market_data_4h",
  "current_price",
  "balance",
  "account_state",
  "indicators",
  "indicators_4h",
  "ema_20",
  "ema_50",
  "macd",
  "rsi_14",
  "atr_14",
  "sharpe_ratio",
  "open_interest",
  "positions",
  "open_positions",
  "funding_rate",
  "funding",
  "open_orders",
  "pending_orders",
  "return_pct",
  "cash_available",
  "account_value",
  "coin_symbol",
  "position_quantity",
  "entry_price",
  "liquidation_price",
  "unrealized_pnl",
  "leverage",
  "profit_target",
  "stop_loss",
  "invalidation_condition",
  "confidence",
  "risk_usd",
  "notional_usd",
  "current_ema20",
  "current_macd",
  "current_rsi7",
  "current_rsi14",
  "current_volume",
  "average_volume",
  "minutes_elapsed",
  "btc_price",
  "btc_ema20",
  "btc_macd",
  "btc_rsi7",
  "btc_rsi14",
  "btc_oi_latest",
  "btc_oi_avg",
  "btc_funding_rate",
  "btc_prices_3m",
  "btc_ema20_3m",
  "btc_macd_3m",
  "btc_rsi7_3m",
  "btc_rsi14_3m",
]);

const ASSET_UNIVERSE = ["BTC", "ETH", "SOL", "BNB", "DOGE", "XRP"];
const INTRADAY_PROMPT_BAR = "3m";
const INTRADAY_INDICATOR_LIMIT = 300;
const FOUR_HOUR_INDICATOR_LIMIT = 300;
const PROMPT_SERIES_POINTS = 20;
const DOUBLE_BRACE_VAR_REGEX = /{{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*}}/g;
const DOLLAR_BRACE_VAR_REGEX = /\$\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}/g;
const SINGLE_BRACE_VAR_REGEX = /{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*}/g;
const COIN_ALIAS_REGEX = /^([a-z]{2,10})_(price|ema20|ema50|macd|rsi7|rsi14|oi_latest|oi_avg|funding_rate|prices_3m|ema20_3m|macd_3m|rsi7_3m|rsi14_3m|ema20_4h|ema50_4h|atr3_4h|atr14_4h|volume_current_4h|volume_avg_4h|volume_current|volume_avg|macd_4h|rsi14_4h)$/;
let tradeRoundCounter = 0;

function nextTradeRound() {
  tradeRoundCounter += 1;
  return tradeRoundCounter;
}

function resolveTemplatePathValue(context: TemplateContext, varName: string) {
  return varName.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, context);
}

function extractTemplateVariables(template: string) {
  const result = new Set<string>();
  let match: RegExpExecArray | null = DOUBLE_BRACE_VAR_REGEX.exec(template);
  while (match) {
    result.add(match[1]);
    match = DOUBLE_BRACE_VAR_REGEX.exec(template);
  }

  match = DOLLAR_BRACE_VAR_REGEX.exec(template);
  while (match) {
    result.add(match[1]);
    match = DOLLAR_BRACE_VAR_REGEX.exec(template);
  }

  const templateWithoutBracedVars = template
    .replace(DOUBLE_BRACE_VAR_REGEX, " ")
    .replace(DOLLAR_BRACE_VAR_REGEX, " ");
  match = SINGLE_BRACE_VAR_REGEX.exec(templateWithoutBracedVars);
  while (match) {
    result.add(match[1]);
    match = SINGLE_BRACE_VAR_REGEX.exec(templateWithoutBracedVars);
  }
  return [...result];
}

function extractRootVariables(templateVariables: string[]) {
  return [...new Set(templateVariables.map((item) => item.split(".")[0]))];
}

function isDynamicCoinAliasVariable(variable: string) {
  return COIN_ALIAS_REGEX.test(variable);
}

function getDynamicAliasMetric(variable: string) {
  const match = variable.match(COIN_ALIAS_REGEX);
  return match ? match[2] : null;
}

function getDynamicAliasCoin(variable: string) {
  const match = variable.match(COIN_ALIAS_REGEX);
  return match ? match[1] : null;
}

function inferFallbackValue(varName: string, currentCoin: string) {
  const key = varName.toLowerCase();
  if (key.includes("invalidation_condition")) return "N/A";
  if (key.includes("coin_symbol")) return currentCoin;
  if (key.includes("market_data")) return [];
  if (isDynamicCoinAliasVariable(varName)) return null;
  return null;
}

function ensureRequestedVariablesFilled(context: TemplateContext, requestedVariables: string[], currentCoin: string) {
  for (const variable of requestedVariables) {
    if (resolveTemplatePathValue(context, variable) !== undefined && resolveTemplatePathValue(context, variable) !== null) {
      continue;
    }
    const fallback = inferFallbackValue(variable, currentCoin);
    context[variable] = fallback;
  }
}

function getEffectiveRequestedVariables(template: string) {
  const parsed = extractRootVariables(extractTemplateVariables(template));
  if (parsed.length > 0) return parsed;
  // Fallback for templates without placeholders to keep core context populated.
  return ["market_data", "balance", "positions", "funding_rate", "open_orders", "current_price", "account_state"];
}

function serializeTemplateValue(value: unknown) {
  if (value === undefined) return "null";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function mapCoinToInstId(coin: string | undefined, fallbackInstId: string) {
  if (!coin) return fallbackInstId;
  const normalized = coin.trim().toUpperCase();
  if (!normalized) return fallbackInstId;
  if (normalized.endsWith("-USDT-SWAP")) return normalized;
  if (normalized.endsWith("-SWAP")) return normalized;
  if (normalized.includes("-")) return `${normalized}-SWAP`;
  return `${normalized}-USDT-SWAP`;
}

function normalizeCandlesOldestToNewest(candles: unknown) {
  if (!Array.isArray(candles)) return [];
  return [...candles]
    .reverse()
    .map((item) => {
      if (!Array.isArray(item)) return item;
      return {
        ts: numberFromUnknown(item[0], 0),
        open: numberFromUnknown(item[1], 0),
        high: numberFromUnknown(item[2], 0),
        low: numberFromUnknown(item[3], 0),
        close: numberFromUnknown(item[4], 0),
        volume: numberFromUnknown(item[5], 0),
        confirmed: item[8] == null ? true : String(item[8]) === "1",
      };
    })
    .filter((item) => {
      if (!item || typeof item !== "object") return false;
      return (item as CandleNormalized).confirmed !== false;
    });
}

function numberFromUnknown(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toCandles(input: unknown): CandleNormalized[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      return {
        ts: numberFromUnknown(row.ts, 0),
        open: numberFromUnknown(row.open, 0),
        high: numberFromUnknown(row.high, 0),
        low: numberFromUnknown(row.low, 0),
        close: numberFromUnknown(row.close, 0),
        volume: numberFromUnknown(row.volume, 0),
        confirmed: row.confirmed == null ? true : Boolean(row.confirmed),
      };
    })
    .filter((item): item is CandleNormalized => item != null && item.confirmed);
}

function calcEma(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let i = period; i < values.length; i += 1) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcEmaSeries(values: number[], period: number): Array<number | null> {
  if (values.length === 0 || period <= 0) return [];
  const k = 2 / (period + 1);
  const result: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) return result;
  let ema = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let i = 0; i < values.length; i += 1) {
    if (i < period - 1) continue;
    if (i === period - 1) {
      result[i] = ema;
    } else {
      ema = values[i] * k + ema * (1 - k);
      result[i] = ema;
    }
  }
  return result;
}

function calcEmaSeriesFromNullable(values: Array<number | null>, period: number): Array<number | null> {
  const result: Array<number | null> = new Array(values.length).fill(null);
  const validStart = values.findIndex((item) => item != null);
  if (validStart < 0 || period <= 0) return result;
  const seedEnd = validStart + period;
  const seedValues = values.slice(validStart, seedEnd);
  if (seedValues.length < period || seedValues.some((item) => item == null)) return result;
  const k = 2 / (period + 1);
  let ema = (seedValues as number[]).reduce((sum, item) => sum + item, 0) / period;
  result[seedEnd - 1] = ema;
  for (let i = seedEnd; i < values.length; i += 1) {
    const value = values[i];
    if (value == null) continue;
    ema = value * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

function calcMacdSeries(values: number[]) {
  const ema12Series = calcEmaSeries(values, 12);
  const ema26Series = calcEmaSeries(values, 26);
  const line = values.map((_value, index) => {
    const ema12 = ema12Series[index];
    const ema26 = ema26Series[index];
    return ema12 == null || ema26 == null ? null : ema12 - ema26;
  });
  const signal = calcEmaSeriesFromNullable(line, 9);
  const histogram = line.map((item, index) => (item == null || signal[index] == null ? null : item - signal[index]!));
  return { line, signal, histogram, ema12: ema12Series, ema26: ema26Series };
}

function calcRsiSeries(values: number[], period: number): Array<number | null> {
  if (values.length < 2 || period <= 0) return [];
  const result: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period + 1) return result;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    const currentGain = delta > 0 ? delta : 0;
    const currentLoss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return result;
}

function getLastNumber(input: unknown) {
  if (!Array.isArray(input)) return null;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const value = Number(input[i]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function lastItems<T>(values: T[], count = PROMPT_SERIES_POINTS) {
  return values.slice(Math.max(values.length - count, 0));
}

function average(values: number[]) {
  const finite = values.filter((item) => Number.isFinite(item));
  if (finite.length === 0) return null;
  return finite.reduce((sum, item) => sum + item, 0) / finite.length;
}

function extractTickerLast(ticker: unknown) {
  if (!ticker || typeof ticker !== "object") return null;
  const row = ticker as Record<string, unknown>;
  return toNumberOrNull(row.last) ?? toNumberOrNull(row.markPx) ?? toNumberOrNull(row.idxPx);
}

function extractOiValue(openInterest: unknown) {
  if (!openInterest || typeof openInterest !== "object") return null;
  const row = openInterest as Record<string, unknown>;
  return toNumberOrNull(row.oi) ?? toNumberOrNull(row.oiCcy) ?? toNumberOrNull(row.oiUsd);
}

function toNumberOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickPrimaryPosition(positions: unknown, instId: string) {
  if (!Array.isArray(positions)) return null;
  const exact = positions.find((item) => {
    if (!item || typeof item !== "object") return false;
    return String((item as Record<string, unknown>).instId || "") === instId;
  });
  if (exact && typeof exact === "object") return exact as Record<string, unknown>;

  const first = positions.find((item) => item && typeof item === "object");
  return first ? (first as Record<string, unknown>) : null;
}

function extractAccountMetrics(balance: unknown) {
  let accountValue: number | null = null;
  let cashAvailable: number | null = null;

  if (!Array.isArray(balance) || balance.length === 0) {
    return { accountValue, cashAvailable };
  }

  const row = balance[0] as Record<string, unknown>;
  accountValue = toNumberOrNull(row.totalEq) ?? toNumberOrNull(row.adjEq) ?? toNumberOrNull(row.isoEq);

  const details = Array.isArray(row.details) ? (row.details as Array<Record<string, unknown>>) : [];
  const usdt = details.find((item) => String(item.ccy || "").toUpperCase() === "USDT") || details[0];
  if (usdt) {
    cashAvailable =
      toNumberOrNull(usdt.availEq) ??
      toNumberOrNull(usdt.availBal) ??
      toNumberOrNull(usdt.cashBal) ??
      toNumberOrNull(usdt.eq);
  }

  if (accountValue == null && details.length > 0) {
    accountValue = details
      .map((item) => toNumberOrNull(item.eq))
      .filter((item): item is number => item != null)
      .reduce((sum, item) => sum + item, 0);
  }

  return { accountValue, cashAvailable };
}

function setAccountAndPositionContext(
  context: TemplateContext,
  input: ResolveContextInput,
  options: {
    returns: number[];
    accountValue: number | null;
    cashAvailable: number | null;
  },
) {
  const { accountValue, cashAvailable, returns } = options;
  const currentPrice = toNumberOrNull(context.current_price) ?? 0;
  const pos = pickPrimaryPosition(context.positions, input.instId);

  const rawInstId = pos ? String(pos.instId || input.instId) : input.instId;
  const coinSymbol = rawInstId.split("-")[0] || input.instId.split("-")[0] || "BTC";
  const positionQuantity = pos
    ? Math.abs(toNumberOrNull(pos.pos) ?? toNumberOrNull(pos.qty) ?? toNumberOrNull(pos.positionAmt) ?? 0)
    : 0;
  const entryPrice = pos ? toNumberOrNull(pos.avgPx) ?? toNumberOrNull(pos.entryPx) ?? 0 : 0;
  const liquidationPrice = pos ? toNumberOrNull(pos.liqPx) ?? 0 : 0;
  const unrealizedPnl = pos ? toNumberOrNull(pos.upl) ?? toNumberOrNull(pos.unrealizedPnl) ?? 0 : 0;
  const leverage = pos ? toNumberOrNull(pos.lever) ?? toNumberOrNull(pos.leverage) ?? 0 : 0;

  const notionalUsd = positionQuantity * (currentPrice || entryPrice || 0);
  const stopLossPct = input.stopLossPct ?? 1.5;
  const takeProfitPct = input.takeProfitPct ?? 3;
  const stopLoss = currentPrice > 0 ? currentPrice * (1 - stopLossPct / 100) : 0;
  const profitTarget = currentPrice > 0 ? currentPrice * (1 + takeProfitPct / 100) : 0;
  const riskUsd = Math.max(notionalUsd * (stopLossPct / 100), 0);
  const totalPnl = returns.reduce((sum, item) => sum + item, 0);
  const returnPct = accountValue && accountValue > 0 ? (totalPnl / accountValue) * 100 : 0;

  Object.assign(context, {
    return_pct: returnPct,
    cash_available: cashAvailable ?? 0,
    account_value: accountValue ?? 0,
    coin_symbol: coinSymbol,
    position_quantity: positionQuantity,
    entry_price: entryPrice,
    liquidation_price: liquidationPrice,
    unrealized_pnl: unrealizedPnl,
    leverage,
    profit_target: profitTarget,
    stop_loss: stopLoss,
    invalidation_condition: `price < ${stopLoss.toFixed(2)}`,
    confidence: 50,
    risk_usd: riskUsd,
    notional_usd: notionalUsd,
  });
}

function setCoinAliasContext(
  context: TemplateContext,
  coin: string,
  source?: {
    marketData?: unknown;
    marketData4h?: unknown;
    fundingRate?: unknown;
    openInterest?: unknown;
    currentPrice?: unknown;
    indicators?: unknown;
    indicators4h?: unknown;
  },
) {
  const coinKey = coin.toLowerCase();
  const marketData = source?.marketData ?? context.market_data;
  const marketData4h = source?.marketData4h ?? context.market_data_4h;
  const fundingRate = source?.fundingRate ?? context.funding_rate;
  const openInterest = source?.openInterest ?? context.open_interest;
  const indicators4hSource = source?.indicators4h ?? context.indicators_4h;

  const candles = toCandles(marketData);
  const closes = candles.map((item) => item.close);
  const volumes = candles.map((item) => item.volume);
  const ema20Series = calcEmaSeries(closes, 20);
  const macdSeries = calcMacdSeries(closes);
  const rsi7Series = calcRsiSeries(closes, 7);
  const rsi14Series = calcRsiSeries(closes, 14);

  const candles4h = toCandles(marketData4h);
  const closes4h = candles4h.map((item) => item.close);
  const volumes4h = candles4h.map((item) => item.volume);
  const macdSeries4h = calcMacdSeries(closes4h);
  const rsi14Series4h = calcRsiSeries(closes4h, 14);
  const indicators4h = (indicators4hSource || {}) as Record<string, unknown>;
  const atr3_4h = calcAtr(candles4h, 3);
  const avgVolume4h = average(lastItems(volumes4h, 20));

  const funding = (fundingRate || {}) as Record<string, unknown>;
  const latestOi = extractOiValue(openInterest);

  const aliasPayload: Record<string, unknown> = {
    [`${coinKey}_price`]: source?.currentPrice ?? context.current_price ?? getLastNumber(closes),
    [`${coinKey}_ema20`]: getLastNumber(ema20Series),
    [`${coinKey}_macd`]: getLastNumber(macdSeries.line),
    [`${coinKey}_rsi7`]: getLastNumber(rsi7Series),
    [`${coinKey}_rsi14`]: getLastNumber(rsi14Series),
    [`${coinKey}_oi_latest`]: latestOi,
    [`${coinKey}_oi_avg`]: null,
    [`${coinKey}_funding_rate`]: funding.fundingRate ?? funding.nextFundingRate ?? null,
    [`${coinKey}_prices_3m`]: lastItems(closes),
    [`${coinKey}_ema20_3m`]: lastItems(ema20Series),
    [`${coinKey}_macd_3m`]: lastItems(macdSeries.line),
    [`${coinKey}_rsi7_3m`]: lastItems(rsi7Series),
    [`${coinKey}_rsi14_3m`]: lastItems(rsi14Series),
    [`${coinKey}_ema20_4h`]: indicators4h.ema_20 ?? null,
    [`${coinKey}_ema50_4h`]: indicators4h.ema_50 ?? null,
    [`${coinKey}_atr3_4h`]: atr3_4h,
    [`${coinKey}_atr14_4h`]: indicators4h.atr_14 ?? null,
    [`${coinKey}_volume_current_4h`]: volumes4h.length ? volumes4h[volumes4h.length - 1] : null,
    [`${coinKey}_volume_avg_4h`]: avgVolume4h,
    [`${coinKey}_volume_current`]: volumes4h.length ? volumes4h[volumes4h.length - 1] : null,
    [`${coinKey}_volume_avg`]: avgVolume4h,
    [`${coinKey}_macd_4h`]: lastItems(macdSeries4h.line),
    [`${coinKey}_rsi14_4h`]: lastItems(rsi14Series4h),
    current_ema20: context.ema_20 ?? getLastNumber(ema20Series),
    current_macd: getLastNumber(macdSeries.line),
    current_rsi7: getLastNumber(rsi7Series),
    current_rsi14: context.rsi_14 ?? getLastNumber(rsi14Series),
    current_volume: volumes.length ? volumes[volumes.length - 1] : null,
    average_volume: average(lastItems(volumes, 20)),
  };

  Object.assign(context, aliasPayload);
}

function calcMacd(values: number[]) {
  const macdSeries = calcMacdSeries(values);
  const line = getLastNumber(macdSeries.line);
  const signal = getLastNumber(macdSeries.signal);
  if (line == null || signal == null) return null;
  return {
    line,
    signal,
    histogram: line - signal,
    ema12: getLastNumber(macdSeries.ema12),
    ema26: getLastNumber(macdSeries.ema26),
  };
}

function calcRsi(values: number[], period = 14) {
  if (values.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    const currentGain = delta > 0 ? delta : 0;
    const currentLoss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcAtr(candles: CandleNormalized[], period = 14) {
  if (candles.length < period + 1) return null;
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prevClose),
      Math.abs(current.low - prevClose),
    );
    trueRanges.push(tr);
  }
  if (trueRanges.length < period) return null;

  let atr = trueRanges.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let i = period; i < trueRanges.length; i += 1) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return atr;
}

function calcSharpe(returns: number[]) {
  if (returns.length < 2) return null;
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => {
      const diff = r - mean;
      return sum + diff * diff;
    }, 0) /
    (returns.length - 1);
  const std = Math.sqrt(variance);
  if (!Number.isFinite(std) || std === 0) return null;
  return (mean / std) * Math.sqrt(returns.length);
}

function calcIndicators(candlesInput: unknown) {
  const candles = toCandles(candlesInput);
  const closes = candles.map((item) => item.close);
  const ema20 = calcEma(closes, 20);
  const ema50 = calcEma(closes, 50);
  const macd = calcMacd(closes);
  const rsi14 = calcRsi(closes, 14);
  const atr14 = calcAtr(candles, 14);
  return {
    ema_20: ema20,
    ema_50: ema50,
    macd,
    rsi_14: rsi14,
    atr_14: atr14,
  };
}

function normalizeInstId(symbol: string) {
  return normalizePerpInstId(symbol);
}

function getPromptTemplate(template: string | null | undefined) {
  const safeTemplate = template?.trim() ? template : DEFAULT_PROMPT_TEMPLATE;
  return safeTemplate;
}

function renderPrompt(template: string, context: TemplateContext) {
  const renderedDoubleBrace = template.replace(DOUBLE_BRACE_VAR_REGEX, (_full, varName: string) => {
    const value = resolveTemplatePathValue(context, varName);
    return serializeTemplateValue(value);
  });

  const renderedDollarBrace = renderedDoubleBrace.replace(DOLLAR_BRACE_VAR_REGEX, (_full, varName: string) => {
    const value = resolveTemplatePathValue(context, varName);
    return serializeTemplateValue(value);
  });

  return renderedDollarBrace.replace(SINGLE_BRACE_VAR_REGEX, (_full, varName: string) => {
    const value = resolveTemplatePathValue(context, varName);
    return serializeTemplateValue(value);
  });
}

function formatNumberForPrompt(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Number(parsed.toFixed(6));
}

function buildAccountPromptAppendix(context: TemplateContext) {
  const metrics = extractAccountMetrics(context.balance);
  const positionsRaw = Array.isArray(context.positions) ? context.positions : [];
  const positions = positionsRaw
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const row = item as Record<string, unknown>;
      return {
        instId: String(row.instId || ""),
        posSide: String(row.posSide || ""),
        qty: formatNumberForPrompt(row.pos ?? row.qty ?? 0),
        entryPrice: formatNumberForPrompt(row.avgPx ?? row.entryPx ?? 0),
        markPrice: formatNumberForPrompt(row.markPx ?? row.last ?? context.current_price ?? 0),
        unrealizedPnl: formatNumberForPrompt(row.upl ?? row.unrealizedPnl ?? 0),
        leverage: formatNumberForPrompt(row.lever ?? row.leverage ?? 0),
      };
    });

  const positionsJson = JSON.stringify(positions.length ? positions : [], null, 2);

  return [
    "",
    "## HERE IS YOUR ACCOUNT INFORMATION & PERFORMANCE",
    "",
    "**Performance Metrics:**",
    `- Current Total Return (percent): ${formatNumberForPrompt(context.return_pct)}%`,
    `- Sharpe Ratio: ${formatNumberForPrompt(context.sharpe_ratio)}`,
    "",
    "**Account Status:**",
    `- Available Cash: $${formatNumberForPrompt(metrics.cashAvailable ?? context.cash_available ?? 0)}`,
    `- **Current Account Value:** $${formatNumberForPrompt(metrics.accountValue ?? context.account_value ?? 0)}`,
    "",
    "**Current Live Positions & Performance:**",
    "```json",
    positionsJson,
    "```",
    "",
    "Based on the above data, provide your trading decision in the required JSON format.",
  ].join("\n");
}

async function resolveTemplateContext(input: ResolveContextInput): Promise<ResolvedTemplateContext> {
  const requestedVariables = getEffectiveRequestedVariables(input.template);
  const requestedAliasCoins = [...new Set(requestedVariables.map((item) => getDynamicAliasCoin(item)).filter((item): item is string => Boolean(item)))];
  const requestedAliasMetrics = requestedVariables
    .map((item) => getDynamicAliasMetric(item))
    .filter((item): item is string => Boolean(item));
  const aliasMetricSet = new Set(requestedAliasMetrics);

  const aliasNeedsMarket = [
    "price",
    "ema20",
    "ema50",
    "macd",
    "rsi7",
    "rsi14",
    "prices_3m",
    "ema20_3m",
    "macd_3m",
    "rsi7_3m",
    "rsi14_3m",
  ].some((metric) => aliasMetricSet.has(metric));
  const aliasNeedsIndicators = ["ema20", "ema50", "macd", "rsi7", "rsi14", "ema20_3m", "macd_3m", "rsi7_3m", "rsi14_3m"].some(
    (metric) => aliasMetricSet.has(metric),
  );
  const aliasNeeds4h = ["ema20_4h", "ema50_4h", "atr3_4h", "atr14_4h", "volume_current_4h", "volume_avg_4h", "volume_current", "volume_avg", "macd_4h", "rsi14_4h"].some(
    (metric) => aliasMetricSet.has(metric),
  );
  const aliasNeedsFunding = aliasMetricSet.has("funding_rate");
  const aliasNeedsOpenInterest = aliasMetricSet.has("oi_latest") || aliasMetricSet.has("oi_avg");
  const unknownVariables = requestedVariables.filter(
    (item) => !BUILTIN_VARIABLES.has(item) && !isDynamicCoinAliasVariable(item),
  );
  const coin = input.instId.split("-")[0] || input.instId;
  const context: TemplateContext = {
    symbol: input.instId,
    coin,
    contract: "perpetual",
    exchange: "OKX",
    asset_universe: ASSET_UNIVERSE,
    decision_frequency: input.timeframe,
    timestamp: new Date().toISOString(),
    timeframe: input.timeframe,
    minutes_elapsed: input.startedAt ? Math.max(0, Math.floor((Date.now() - input.startedAt.getTime()) / 60000)) : 0,
  };

  const okxEndpoints: string[] = [];
  const marketBar = aliasNeedsMarket || aliasNeedsIndicators ? INTRADAY_PROMPT_BAR : input.bar;
  const marketLimit = aliasNeedsMarket || aliasNeedsIndicators ? INTRADAY_INDICATOR_LIMIT : 120;

  const fetchTasks: Array<Promise<void>> = [];
  const needs = (names: string[]) => names.some((item) => requestedVariables.includes(item));

  if (needs(["market_data", "market_data_raw", "current_price", "account_state"]) || aliasNeedsMarket || aliasNeedsIndicators) {
    okxEndpoints.push(`/api/v5/market/candles?bar=${marketBar}&limit=${marketLimit}`);
    okxEndpoints.push("/api/v5/market/ticker");
    fetchTasks.push(
      (async () => {
        const [rawCandles, ticker] = await Promise.all([
          okxAdapter.getCandles(input.instId, marketBar, marketLimit),
          okxAdapter.getTicker(input.instId).catch(() => null),
        ]);
        const normalized = normalizeCandlesOldestToNewest(rawCandles);
        context.market_data_raw = rawCandles;
        context.market_data = normalized;
        const latest = Array.isArray(normalized) && normalized.length > 0 ? normalized[normalized.length - 1] : null;
        const latestClose = latest && typeof latest === "object" ? (latest as Record<string, unknown>).close : null;
        context.current_price = extractTickerLast(ticker) ?? toNumberOrNull(latestClose);
      })(),
    );
  }

  if (needs(["market_data_4h", "indicators_4h"]) || aliasNeeds4h) {
    okxEndpoints.push(`/api/v5/market/candles?bar=4H&limit=${FOUR_HOUR_INDICATOR_LIMIT}`);
    fetchTasks.push(
      (async () => {
        const raw4h = await okxAdapter.getCandles(input.instId, "4H", FOUR_HOUR_INDICATOR_LIMIT);
        context.market_data_4h = normalizeCandlesOldestToNewest(raw4h);
      })(),
    );
  }

  if (true) {
    okxEndpoints.push("/api/v5/account/balance");
    fetchTasks.push(
      (async () => {
        try {
          const balance = await okxAdapter.getBalance(input.env);
          context.balance = balance;
        } catch (error) {
          context.balance = [];
          context._balance_fetch_error = error instanceof Error ? error.message : String(error);
        }
      })(),
    );
  }

  if (true) {
    okxEndpoints.push("/api/v5/account/positions");
    fetchTasks.push(
      (async () => {
        try {
          const positions = await okxAdapter.getPositions("SWAP", input.env);
          context.positions = positions;
          context.open_positions = positions;
        } catch (error) {
          context.positions = [];
          context.open_positions = [];
          context._positions_fetch_error = error instanceof Error ? error.message : String(error);
        }
      })(),
    );
  }

  if (needs(["funding_rate", "funding", "account_state"]) || aliasNeedsFunding) {
    okxEndpoints.push("/api/v5/public/funding-rate");
    fetchTasks.push(
      (async () => {
        const fundingRate = await okxAdapter.getFundingRate(input.instId);
        context.funding_rate = fundingRate;
        context.funding = fundingRate;
      })(),
    );
  }

  if (needs(["open_interest", "account_state"]) || aliasNeedsOpenInterest) {
    okxEndpoints.push("/api/v5/public/open-interest");
    fetchTasks.push(
      (async () => {
        const oi = await okxAdapter.getOpenInterest(input.instId, "SWAP");
        context.open_interest = oi;
      })(),
    );
  }

  if (needs(["open_orders", "pending_orders", "account_state"])) {
    okxEndpoints.push("/api/v5/trade/orders-pending");
    fetchTasks.push(
      (async () => {
        const orders = await okxAdapter.getPendingOrders("SWAP", input.env);
        context.open_orders = orders;
        context.pending_orders = orders;
      })(),
    );
  }

  await Promise.all(fetchTasks);

  if (needs(["indicators", "ema_20", "ema_50", "macd", "rsi_14", "atr_14", "account_state"]) || aliasNeedsIndicators) {
    const indicators = calcIndicators(context.market_data);
    context.indicators = indicators;
    context.ema_20 = indicators.ema_20;
    context.ema_50 = indicators.ema_50;
    context.macd = indicators.macd;
    context.rsi_14 = indicators.rsi_14;
    context.atr_14 = indicators.atr_14;
  }

  if (needs(["indicators_4h"]) || aliasNeeds4h) {
    context.indicators_4h = calcIndicators(context.market_data_4h);
  }

  if (needs(["sharpe_ratio", "account_state"])) {
    const pnlRows = await prisma.pnLDaily.findMany({
      where: { userId: input.userId },
      orderBy: { date: "desc" },
      take: 30,
      select: {
        realizedPnl: true,
        unrealizedPnl: true,
        feeTotal: true,
      },
    });
    const returns = pnlRows
      .map((row) => row.realizedPnl + row.unrealizedPnl - row.feeTotal)
      .reverse();
    context.sharpe_ratio = calcSharpe(returns);
  }

  const pnlRowsForAccount = await prisma.pnLDaily.findMany({
    where: { userId: input.userId },
    orderBy: { date: "desc" },
    take: 30,
    select: {
      realizedPnl: true,
      unrealizedPnl: true,
      feeTotal: true,
    },
  });
  const pnlReturns = pnlRowsForAccount
    .map((row) => row.realizedPnl + row.unrealizedPnl - row.feeTotal)
    .reverse();

  const accountMetrics = extractAccountMetrics(context.balance);
  setAccountAndPositionContext(context, input, {
    returns: pnlReturns,
    accountValue: accountMetrics.accountValue,
    cashAvailable: accountMetrics.cashAvailable,
  });

  context.account_state = {
    symbol: input.instId,
    timestamp: context.timestamp,
    current_price: context.current_price || null,
    balance: context.balance || null,
    positions: context.positions || [],
    funding_rate: context.funding_rate || null,
    open_interest: context.open_interest || null,
    open_orders: context.open_orders || [],
    indicators: context.indicators || null,
    sharpe_ratio: context.sharpe_ratio || null,
  };

  setCoinAliasContext(context, coin);

  for (const aliasCoin of requestedAliasCoins) {
    if (aliasCoin === coin.toLowerCase()) continue;

    const aliasInstId = mapCoinToInstId(aliasCoin, input.instId);
    try {
      const [rawCandles, raw4h, fundingRate, openInterest, ticker] = await Promise.all([
        okxAdapter.getCandles(aliasInstId, INTRADAY_PROMPT_BAR, INTRADAY_INDICATOR_LIMIT),
        okxAdapter.getCandles(aliasInstId, "4H", FOUR_HOUR_INDICATOR_LIMIT),
        okxAdapter.getFundingRate(aliasInstId),
        okxAdapter.getOpenInterest(aliasInstId, "SWAP"),
        okxAdapter.getTicker(aliasInstId).catch(() => null),
      ]);

      const aliasMarketData = normalizeCandlesOldestToNewest(rawCandles);
      const aliasMarketData4h = normalizeCandlesOldestToNewest(raw4h);
      const aliasIndicators = calcIndicators(aliasMarketData);
      const aliasIndicators4h = calcIndicators(aliasMarketData4h);
      const latestAlias = aliasMarketData.length ? aliasMarketData[aliasMarketData.length - 1] : null;
      const latestAliasPrice = latestAlias ? numberFromUnknown((latestAlias as Record<string, unknown>).close, 0) : null;

      setCoinAliasContext(context, aliasCoin.toUpperCase(), {
        marketData: aliasMarketData,
        marketData4h: aliasMarketData4h,
        fundingRate,
        openInterest,
        currentPrice: extractTickerLast(ticker) ?? latestAliasPrice,
        indicators: aliasIndicators,
        indicators4h: aliasIndicators4h,
      });

      okxEndpoints.push(`/api/v5/market/candles?instId=${aliasInstId}&bar=${INTRADAY_PROMPT_BAR}&limit=${INTRADAY_INDICATOR_LIMIT}`);
      okxEndpoints.push(`/api/v5/market/candles?instId=${aliasInstId}&bar=4H&limit=${FOUR_HOUR_INDICATOR_LIMIT}`);
      okxEndpoints.push(`/api/v5/public/funding-rate?instId=${aliasInstId}`);
      okxEndpoints.push(`/api/v5/public/open-interest?instId=${aliasInstId}`);
      okxEndpoints.push(`/api/v5/market/ticker?instId=${aliasInstId}`);
    } catch {
      setCoinAliasContext(context, aliasCoin.toUpperCase());
    }
  }

  ensureRequestedVariablesFilled(context, requestedVariables, coin);

  return {
    context,
    requestedVariables,
    unknownVariables,
    okxEndpoints,
  };
}

function parseDecision(raw: string, minLeverage: number, maxLeverage: number): ParsedDecision {
  const cleaned = raw.trim().startsWith("```")
    ? raw.trim().replace(/^```json\s*/i, "").replace(/^```/, "").replace(/```$/, "")
    : raw;

  const parsedUnknown = JSON.parse(cleaned) as unknown;
  if (!parsedUnknown || typeof parsedUnknown !== "object" || Array.isArray(parsedUnknown)) {
    throw new Error("LLM 决策必须是 JSON object");
  }

  const parsed = parsedUnknown as Partial<DemoDecision> & {
    signal?: unknown;
    action?: unknown;
    coin?: unknown;
    quantity?: unknown;
    justification?: unknown;
    profit_target?: unknown;
    stop_loss?: unknown;
    invalidation_condition?: unknown;
    confidence?: unknown;
    risk_usd?: unknown;
  };
  const validationErrors: string[] = [];
  const signal = typeof parsed.signal === "string" ? parsed.signal : undefined;
  const actionRaw = typeof parsed.action === "string" ? parsed.action : undefined;

  const mappedActionFromSignal =
    signal === "buy_to_enter"
      ? "buy"
      : signal === "sell_to_enter"
        ? "sell"
        : signal === "close"
          ? "close"
          : signal === "hold"
            ? "hold"
            : null;

  const action =
    mappedActionFromSignal ||
    (actionRaw === "buy" || actionRaw === "sell" || actionRaw === "hold" || actionRaw === "close"
      ? actionRaw
      : "hold");

  if (!mappedActionFromSignal && actionRaw == null) {
    validationErrors.push("缺少 signal/action 字段");
  }
  if (signal && !["buy_to_enter", "sell_to_enter", "hold", "close"].includes(signal)) {
    validationErrors.push(`signal 非法: ${signal}`);
  }
  if (actionRaw && !["buy", "sell", "hold", "close"].includes(actionRaw)) {
    validationErrors.push(`action 非法: ${actionRaw}`);
  }

  const sizeCandidate = typeof parsed.quantity === "number" ? parsed.quantity : parsed.size;
  const size = typeof sizeCandidate === "number" && sizeCandidate > 0 ? sizeCandidate : 0;
  if (action !== "hold" && action !== "close" && size <= 0) {
    validationErrors.push("开仓决策 quantity/size 必须为正数");
  }

  const coin = typeof parsed.coin === "string" ? parsed.coin : undefined;
  if (action !== "hold" && !coin) {
    validationErrors.push("非 hold 决策必须包含 coin");
  }

  const leverage =
    typeof parsed.leverage === "number"
      ? Math.max(minLeverage, Math.min(maxLeverage, parsed.leverage))
      : (minLeverage + maxLeverage) / 2;
  if (typeof parsed.leverage !== "number" || !Number.isFinite(parsed.leverage)) {
    validationErrors.push("leverage 必须是数字");
  }

  const confidenceRaw = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence) ? parsed.confidence : 0;
  const confidence = Math.max(0, Math.min(100, confidenceRaw <= 1 ? confidenceRaw * 100 : confidenceRaw));
  if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence)) {
    validationErrors.push("confidence 必须是数字");
  }

  for (const field of ["profit_target", "stop_loss", "risk_usd"] as const) {
    if (action !== "hold" && (typeof parsed[field] !== "number" || !Number.isFinite(parsed[field] as number))) {
      validationErrors.push(`${field} 必须是数字`);
    }
  }
  if (action !== "hold" && typeof parsed.invalidation_condition !== "string") {
    validationErrors.push("invalidation_condition 必须是字符串");
  }

  const targetInstId = mapCoinToInstId(coin, "");

  return {
    action,
    size,
    leverage,
    reason:
      typeof parsed.reason === "string"
        ? parsed.reason
        : typeof parsed.justification === "string"
          ? parsed.justification
          : "",
    targetInstId: targetInstId || undefined,
    confidence,
    raw: parsedUnknown as Record<string, unknown>,
    validationErrors,
  };
}

function isDeepSeekConfig(llm: Pick<LlmRuntimeConfig, "provider" | "baseUrl" | "model">) {
  const provider = llm.provider.toLowerCase();
  const baseUrl = llm.baseUrl.toLowerCase();
  const model = llm.model.toLowerCase();
  return provider.includes("deepseek") || baseUrl.includes("deepseek") || model.includes("deepseek");
}

function previewText(text: string, max = 240) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function roundTag(round: number | undefined, label: string) {
  return round == null ? `【${label}】` : `【Round ${round} | ${label}】`;
}

function logTradeEvent(tag: string, detail: Record<string, unknown>, round?: number) {
  const normalizedTag = tag.replace(/^【|】$/g, "");
  console.log(roundTag(round, normalizedTag), {
    timestamp: new Date().toISOString(),
    ...detail,
  });
}

function roundForAudit(value: unknown, digits = 8) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value ?? null;
  return Number(parsed.toFixed(digits));
}

function normalizeSeriesForAudit(value: unknown, digits = 8) {
  if (!Array.isArray(value)) return value ?? null;
  return value.map((item) => (item == null ? null : roundForAudit(item, digits)));
}

function compactCandlesForAudit(candles: unknown, limit = 20) {
  if (!Array.isArray(candles)) return [];
  return candles.slice(Math.max(candles.length - limit, 0)).map((item) => {
    if (!item || typeof item !== "object") return item;
    const row = item as Record<string, unknown>;
    return {
      ts: row.ts ?? null,
      open: roundForAudit(row.open),
      high: roundForAudit(row.high),
      low: roundForAudit(row.low),
      close: roundForAudit(row.close),
      volume: roundForAudit(row.volume),
      confirmed: row.confirmed ?? null,
    };
  });
}

function buildCoinAuditBlock(context: TemplateContext, coin: string) {
  const key = coin.toLowerCase();
  return {
    coin,
    currentSnapshot: {
      price: roundForAudit(context[`${key}_price`]),
      ema20: roundForAudit(context[`${key}_ema20`]),
      macd: roundForAudit(context[`${key}_macd`]),
      rsi7: roundForAudit(context[`${key}_rsi7`]),
      rsi14: roundForAudit(context[`${key}_rsi14`]),
    },
    perpetualFutures: {
      openInterestLatest: roundForAudit(context[`${key}_oi_latest`]),
      openInterestAverage: context[`${key}_oi_avg`] == null ? null : roundForAudit(context[`${key}_oi_avg`]),
      fundingRate: roundForAudit(context[`${key}_funding_rate`], 12),
    },
    intraday3mOldestToNewest: {
      closePrices: normalizeSeriesForAudit(context[`${key}_prices_3m`]),
      ema20: normalizeSeriesForAudit(context[`${key}_ema20_3m`]),
      macdLine: normalizeSeriesForAudit(context[`${key}_macd_3m`]),
      rsi7: normalizeSeriesForAudit(context[`${key}_rsi7_3m`]),
      rsi14: normalizeSeriesForAudit(context[`${key}_rsi14_3m`]),
    },
    fourHourContext: {
      ema20: roundForAudit(context[`${key}_ema20_4h`]),
      ema50: roundForAudit(context[`${key}_ema50_4h`]),
      atr3: roundForAudit(context[`${key}_atr3_4h`]),
      atr14: roundForAudit(context[`${key}_atr14_4h`]),
      currentVolume: roundForAudit(context[`${key}_volume_current`]),
      averageVolume20Bars: roundForAudit(context[`${key}_volume_avg`]),
      macdLineSeries: normalizeSeriesForAudit(context[`${key}_macd_4h`]),
      rsi14Series: normalizeSeriesForAudit(context[`${key}_rsi14_4h`]),
    },
  };
}

function buildPromptAuditLog(context: TemplateContext, requestedVariables: string[], renderedPrompt: string) {
  const requestedCoins = [...new Set(requestedVariables.map((item) => getDynamicAliasCoin(item)).filter((item): item is string => Boolean(item)))];
  return {
    minutesElapsed: context.minutes_elapsed ?? null,
    dataOrdering: "oldest -> newest",
    intradaySource: {
      bar: INTRADAY_PROMPT_BAR,
      calculationPrice: "close on confirmed candles",
      outputPoints: PROMPT_SERIES_POINTS,
    },
    fourHourSource: {
      bar: "4H",
      volumeAverageWindowBars: 20,
    },
    coins: requestedCoins.map((coin) => buildCoinAuditBlock(context, coin.toUpperCase())),
    recentRawCandles: {
      currentSymbol3m: compactCandlesForAudit(context.market_data),
      currentSymbol4h: compactCandlesForAudit(context.market_data_4h),
    },
    unresolvedButExplicitlyNull: requestedVariables.filter((variable) => resolveTemplatePathValue(context, variable) === null),
    finalRenderedUserPrompt: renderedPrompt,
  };
}

function logReadableJson(tag: string, data: unknown, round?: number) {
  if (process.env.LOG_PROMPT_AUDIT !== "true") return;
  const normalizedTag = tag.replace(/^【|】$/g, "");
  console.log(`${roundTag(round, normalizedTag)}\n${JSON.stringify(data, null, 2)}`);
}

function logFullLlmResponse(round: number | undefined, content: string) {
  console.log(`${roundTag(round, "LLM full response")}\n${content}`);
}

function extractChatContent(raw: unknown) {
  const choice = (raw as { choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }> })?.choices?.[0];
  return {
    content: choice?.message?.content || "",
    reasoningContent: choice?.message?.reasoning_content || "",
    finishReason: choice?.finish_reason || null,
  };
}

function buildLlmMessages(systemPrompt: string, userPrompt: string, compact = false) {
  const jsonInstruction = compact
    ? "Return the final decision JSON immediately. No reasoning, no markdown. The first character must be { and the last character must be }."
    : "You must return one valid JSON object only. Do not return markdown or an empty object. Keep private reasoning short and put the final JSON in message.content.";
  return [
    { role: "system" as const, content: `${systemPrompt}\n\n${jsonInstruction}` },
    { role: "user" as const, content: compact ? `${userPrompt}\n\nFINAL ANSWER ONLY: return compact JSON now.` : userPrompt },
  ];
}

function getLlmMaxTokens(llm: LlmRuntimeConfig, isDeepSeek: boolean, retry = false) {
  const configured = llm.maxTokens ?? 800;
  if (!isDeepSeek) return configured;
  return Math.max(configured, retry ? 16384 : 16384);
}

function getLlmTimeoutMs(isDeepSeek: boolean, retry = false) {
  if (!isDeepSeek) return 30000;
  return retry ? 180000 : 150000;
}

function extractLatestCandleSummary(candles: unknown) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const latest = candles[candles.length - 1];
  if (Array.isArray(latest)) {
    return {
      ts: latest[0] || null,
      open: latest[1] || null,
      high: latest[2] || null,
      low: latest[3] || null,
      close: latest[4] || null,
    };
  }
  return latest;
}

async function callLlmWithConfig(
  prompt: string,
  llm: LlmRuntimeConfig,
  round?: number,
) {
  const baseUrl = (llm.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = llm.model || "gpt-4o-mini";
  const url = `${baseUrl}/chat/completions`;
  const isDeepSeek = isDeepSeekConfig(llm);

  const { decryptText } = await import("@/lib/crypto");
  const storedApiKey = llm.encryptedApiKey ? decryptText(llm.encryptedApiKey) : "";
  const apiKey =
    (isDeepSeek ? process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || storedApiKey : process.env.OPENAI_API_KEY || storedApiKey || process.env.LLM_API_KEY) ||
    "";

  const llmRequestData = {
    endpoint: "/chat/completions",
    provider: llm.provider,
    model,
    temperature: llm.temperature ?? 0.3,
    maxTokens: getLlmMaxTokens(llm, isDeepSeek),
    responseFormat: isDeepSeek ? "prompt_json_instruction" : "json_object",
    messages: {
      systemPromptPreview: previewText(llm.systemPrompt),
      userPromptPreview: previewText(prompt),
      userPromptLength: prompt.length,
    },
  };

  logTradeEvent("【LLM decision request】", {
    success: true,
    flow: "host -> LLM",
    url,
    requestData: llmRequestData,
  }, round);

  if (!apiKey) {
    logTradeEvent("【LLM dicision response】", {
      success: false,
      flow: "host <- LLM",
      status: null,
      model,
      responseData: {
        error: "LLM API Key 缺失，请先在系统配置中保存可用密钥",
        expectedRequest: llmRequestData,
      },
    }, round);
    throw new Error("LLM API Key 缺失，请先在系统配置中保存可用密钥");
  }

  const requestLog = logOutboundRequestStart({
    channel: "llm",
    method: "POST",
    url,
    meta: {
      model,
      messageCount: 2,
      responseFormat: isDeepSeek ? "prompt_json_instruction" : "json_object",
    },
  });

  try {
    const makeRequest = (retry = false) =>
      axios.post(
        url,
        {
          model,
          temperature: retry ? 0 : llm.temperature ?? 0.3,
          max_tokens: getLlmMaxTokens(llm, isDeepSeek, retry),
          ...(!isDeepSeek ? { response_format: { type: "json_object" } } : {}),
          messages: buildLlmMessages(llm.systemPrompt, prompt, retry),
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: getLlmTimeoutMs(isDeepSeek, retry),
        },
      );

    let response = await makeRequest(false);
    let extracted = extractChatContent(response.data);
    let content = extracted.content || "{}";
    let finishReason = extracted.finishReason;
    let reasoningContent = extracted.reasoningContent;

    if (isDeepSeek && (!extracted.content.trim() || extracted.content.trim() === "{}") && finishReason === "length") {
      logTradeEvent("【LLM retry request】", {
        success: true,
        flow: "host -> LLM",
        url,
        requestData: {
          reason: "DeepSeek reasoning consumed max_tokens before final content",
          retryMaxTokens: getLlmMaxTokens(llm, isDeepSeek, true),
          previousReasoningPreview: previewText(reasoningContent, 1200),
        },
      }, round);
      response = await makeRequest(true);
      extracted = extractChatContent(response.data);
      content = extracted.content || "{}";
      finishReason = extracted.finishReason;
      reasoningContent = extracted.reasoningContent;
    }

    if (!content.trim()) content = "{}";
    if (content.trim() === "{}") {
      const rawText = JSON.stringify(response.data);
      if (typeof reasoningContent === "string" && reasoningContent.trim().startsWith("{")) {
        content = reasoningContent;
      } else {
        logTradeEvent("【LLM empty object warning】", {
          success: false,
          flow: "host validation",
          status: response.status,
          model,
          responseData: {
            finishReason,
            reasoningPreview: previewText(reasoningContent, 1200),
            rawResponsePreview: previewText(rawText, 1200),
          },
        }, round);
      }
    }

    logFullLlmResponse(round, content);

    logOutboundRequestSuccess(requestLog, response.status, {
      model,
      hasChoices: Array.isArray((response.data as { choices?: unknown[] })?.choices),
      finishReason,
      responsePreview: previewText(content),
    });

    logTradeEvent("【LLM dicision response】", {
      success: true,
      flow: "host <- LLM",
      status: response.status,
      model,
      responseData: {
        contentPreview: previewText(content, 500),
        finishReason,
        hasChoices: Array.isArray((response.data as { choices?: unknown[] })?.choices),
        rawResponsePreview: previewText(JSON.stringify(response.data), 800),
      },
    }, round);

    return content;
  } catch (error) {
    const maybeError = error as { response?: { status?: number; data?: unknown } };
    logOutboundRequestError(requestLog, error, {
      model,
      status: maybeError.response?.status || null,
      response: maybeError.response?.data || null,
    });

    logTradeEvent("【LLM dicision response】", {
      success: false,
      flow: "host <- LLM",
      status: maybeError.response?.status || null,
      model,
      responseData: {
        error: error instanceof Error ? error.message : String(error),
        code: (error as { code?: unknown }).code ?? null,
        timeoutMs: getLlmTimeoutMs(isDeepSeek),
        responsePreview: maybeError.response?.data ? previewText(JSON.stringify(maybeError.response.data), 1200) : null,
        expectedRequest: llmRequestData,
      },
    }, round);
    throw error;
  }
}

function pickPositionToClose(targetInstId: string, positions: unknown) {
  if (!Array.isArray(positions)) return null;
  const hit = positions.find((item) => {
    if (!item || typeof item !== "object") return false;
    return String((item as Record<string, unknown>).instId || "") === targetInstId;
  });
  if (!hit || typeof hit !== "object") return null;

  const row = hit as Record<string, unknown>;
  const posRaw = Number(row.pos || 0);
  if (!Number.isFinite(posRaw) || posRaw === 0) return null;

  const posSide = String(row.posSide || "").toLowerCase();
  let closeSide: "buy" | "sell" = posRaw > 0 ? "sell" : "buy";
  if (posSide === "long") closeSide = "sell";
  if (posSide === "short") closeSide = "buy";

  return {
    side: closeSide,
    size: String(Math.abs(posRaw)),
    source: {
      pos: row.pos || null,
      posSide: row.posSide || null,
      instId: row.instId || null,
    },
  };
}

function getPositionQuantityForSymbol(positions: unknown, instId: string) {
  const pos = pickPrimaryPosition(positions, instId);
  if (!pos) return 0;
  return toNumberOrNull(pos.pos) ?? toNumberOrNull(pos.qty) ?? toNumberOrNull(pos.positionAmt) ?? 0;
}

function mapDecisionToOrderAction(decision: DemoDecision, positions: unknown, instId: string): OrderAction {
  if (decision.action === "buy") return "buy";
  if (decision.action === "sell") return "sell";
  if (decision.action === "hold") return "hold";

  const pos = pickPrimaryPosition(positions, instId);
  const posSide = pos ? String(pos.posSide || "").toLowerCase() : "";
  const posQty = getPositionQuantityForSymbol(positions, instId);
  if (posSide === "short" || posQty < 0) return "close_short";
  return "close_long";
}

function sideForDecision(action: OrderAction, fallback: OrderSide = "buy"): OrderSide {
  if (action === "buy" || action === "open_long" || action === "close_short") return "buy";
  if (action === "sell" || action === "open_short" || action === "close_long") return "sell";
  return fallback;
}

function getSymbolScopedValue(context: TemplateContext, symbol: string, metric: string) {
  const coin = symbol.split("-")[0]?.toLowerCase();
  if (!coin) return null;
  return context[`${coin}_${metric}`] ?? null;
}

function buildMarketSnapshotForOrder(context: TemplateContext, symbol: string, trace?: { traceId: string; executionId: string }) {
  const referencePrice = getReferencePriceForSymbol(context, symbol);
  return {
    traceId: trace?.traceId,
    executionId: trace?.executionId,
    symbol,
    timestamp: context.timestamp ?? new Date().toISOString(),
    referencePrice,
    currentPrice: referencePrice,
    priceSource: referencePrice == null ? "missing_symbol_scoped_price" : "symbol_scoped_alias_or_current_symbol",
    indicators: {
      ema20: getSymbolScopedValue(context, symbol, "ema20") ?? context.ema_20 ?? null,
      macd: getSymbolScopedValue(context, symbol, "macd") ?? context.macd ?? null,
      rsi7: getSymbolScopedValue(context, symbol, "rsi7") ?? null,
      rsi14: getSymbolScopedValue(context, symbol, "rsi14") ?? context.rsi_14 ?? null,
      ema20_4h: getSymbolScopedValue(context, symbol, "ema20_4h") ?? null,
      ema50_4h: getSymbolScopedValue(context, symbol, "ema50_4h") ?? null,
      atr14_4h: getSymbolScopedValue(context, symbol, "atr14_4h") ?? null,
    },
    fundingRate: getSymbolScopedValue(context, symbol, "funding_rate") ?? context.funding_rate ?? null,
    openInterest: getSymbolScopedValue(context, symbol, "oi_latest") ?? context.open_interest ?? null,
  };
}

function buildAccountSnapshotForOrder(context: TemplateContext, trace?: { traceId: string; executionId: string }) {
  return {
    traceId: trace?.traceId,
    executionId: trace?.executionId,
    accountValue: context.account_value ?? null,
    cashAvailable: context.cash_available ?? null,
    positions: context.positions ?? [],
    balance: context.balance ?? null,
  };
}

async function saveAccountSnapshot(userId: string, context: TemplateContext) {
  const equity = toNumberOrNull(context.account_value);
  const available = toNumberOrNull(context.cash_available);
  if (equity == null && available == null) return null;
  return prisma.accountSnapshot.create({
    data: {
      userId,
      equity: equity ?? available ?? 0,
      balance: equity ?? available ?? 0,
      available: available ?? equity ?? 0,
      marginRatio: null,
      totalUnrealized: toNumberOrNull(context.unrealized_pnl),
    },
  });
}

async function hasDuplicateAction(input: {
  userId: string;
  symbol: string;
  action: "buy" | "sell";
  positions: unknown;
  env: OkxEnv;
}) {
  const existingQty = getPositionQuantityForSymbol(input.positions, input.symbol);
  if (existingQty !== 0) {
    return "已有同标的持仓，禁止重复开仓";
  }

  const recentCutoff = new Date(Date.now() - 3 * 60 * 1000);
  const recentOrders = await prisma.tradeOrder.findMany({
    where: {
      userId: input.userId,
      symbol: input.symbol,
      status: { in: ["pending", "placed", "partially_filled", "filled"] },
      createdAt: { gte: recentCutoff },
    },
    orderBy: { createdAt: "desc" },
  });
  const duplicateBlock = findDuplicateOpenBlock({
    symbol: input.symbol,
    action: input.action,
    positionQuantity: existingQty,
    recentOrders: recentOrders as RecentOrderLike[],
  });
  if (duplicateBlock) return duplicateBlock;

  const cooldownCutoff = new Date(Date.now() - 15 * 60 * 1000);
  const recentCloseOrders = await prisma.tradeOrder.findMany({
    where: {
      userId: input.userId,
      symbol: input.symbol,
      action: { in: ["close_long", "close_short"] },
      status: { in: ["pending", "placed", "partially_filled", "filled"] },
      createdAt: { gte: cooldownCutoff },
    },
    orderBy: { createdAt: "desc" },
  });
  const cooldownBlock = findPostCloseCooldownBlock({
    symbol: input.symbol,
    action: input.action,
    recentOrders: recentCloseOrders as RecentOrderLike[],
  });
  if (cooldownBlock) return cooldownBlock;

  try {
    const pendingOrders = await okxAdapter.getPendingOrders("SWAP", input.env);
    const pendingForSymbol = Array.isArray(pendingOrders)
      ? pendingOrders.find((item) => item && typeof item === "object" && String((item as Record<string, unknown>).instId || "") === input.symbol)
      : null;
    if (pendingForSymbol) {
      return "OKX 当前已有同标的未完成挂单，禁止重复下单";
    }
  } catch {
    // DB and position checks still protect the common duplicate paths.
  }

  return null;
}

async function recordTradeOrder(input: {
  traceId: string;
  executionId: string;
  userId: string;
  aiDecisionLogId: string;
  env: OkxEnv;
  symbol: string;
  action: OrderAction;
  side: OrderSide;
  status: OrderStatus;
  quantity: number;
  price?: number | null;
  fee?: number | null;
  estimatedSlippage?: number | null;
  orderResponse?: Prisma.InputJsonValue;
  reasonSummary?: string;
  reasonRaw?: string;
  reasonTags?: string[];
  marketSnapshot: Prisma.InputJsonValue;
  accountSnapshotBefore: Prisma.InputJsonValue;
  accountSnapshotAfter?: Prisma.InputJsonValue;
}) {
  return prisma.tradeOrder.create({
    data: {
      traceId: input.traceId,
      executionId: input.executionId,
      userId: input.userId,
      aiDecisionLogId: input.aiDecisionLogId,
      exchange: "okx",
      envType: input.env,
      symbol: input.symbol,
      action: input.action,
      side: input.side,
      orderType: "market",
      status: input.status,
      triggerSource: "ai",
      price: input.price,
      quantity: input.quantity,
      fee: input.fee ?? null,
      estimatedSlippage: input.estimatedSlippage ?? null,
      aiDecisionSummary: input.reasonSummary,
      aiRawReason: input.reasonRaw,
      reasonTags: input.reasonTags || [],
      marketSnapshot: input.marketSnapshot,
      accountSnapshotBefore: input.accountSnapshotBefore,
      accountSnapshotAfter: input.accountSnapshotAfter ?? Prisma.JsonNull,
      orderResponse: input.orderResponse ?? Prisma.JsonNull,
    },
  });
}

function extractOkxOrderId(orderResult: unknown) {
  if (!orderResult || typeof orderResult !== "object") return null;
  const row = orderResult as Record<string, unknown>;
  return String(row.ordId || row.orderId || "").trim() || null;
}

function weightedAverageFillPrice(fills: Array<Record<string, unknown>>) {
  let notional = 0;
  let size = 0;
  for (const fill of fills) {
    const fillPx = toNumberOrNull(fill.fillPx);
    const fillSz = toNumberOrNull(fill.fillSz);
    if (fillPx == null || fillSz == null) continue;
    notional += fillPx * fillSz;
    size += fillSz;
  }
  return size > 0 ? notional / size : null;
}

function sumFillField(fills: Array<Record<string, unknown>>, field: string) {
  const values = fills.map((fill) => toNumberOrNull(fill[field])).filter((item): item is number => item != null);
  if (values.length === 0) return null;
  return values.reduce((sum, item) => sum + item, 0);
}

async function loadExecutionDetails(input: {
  env: OkxEnv;
  symbol: string;
  side: OrderSide;
  orderResult: unknown;
  referencePrice: number | null;
  traceId: string;
  executionId: string;
}) {
  const orderId = extractOkxOrderId(input.orderResult);
  let orderDetail: Record<string, unknown> | null = null;
  let fills: Array<Record<string, unknown>> = [];
  let fillFetchError: string | null = null;

  if (orderId) {
    try {
      orderDetail = await okxAdapter.getOrder(input.symbol, orderId, input.env) as Record<string, unknown> | null;
    } catch (error) {
      fillFetchError = `订单详情查询失败: ${error instanceof Error ? error.message : String(error)}`;
    }

    try {
      const rawFills = await okxAdapter.getFills(input.symbol, orderId, input.env);
      fills = Array.isArray(rawFills)
        ? (rawFills as unknown[]).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        : [];
    } catch (error) {
      fillFetchError = [fillFetchError, `成交明细查询失败: ${error instanceof Error ? error.message : String(error)}`]
        .filter(Boolean)
        .join("; ");
    }
  }

  const avgPx = toNumberOrNull(orderDetail?.avgPx) ?? weightedAverageFillPrice(fills);
  const fillSize = toNumberOrNull(orderDetail?.accFillSz) ?? sumFillField(fills, "fillSz");
  const fee = sumFillField(fills, "fee");
  const feeCcy = fills.find((fill) => fill.feeCcy)?.feeCcy;
  const status = classifyOkxOrderStatus(orderDetail?.state, Boolean(orderId));
  const { slippage, slippageBps } = calculateDirectionalSlippage({
    side: input.side,
    executedPrice: avgPx,
    referencePrice: input.referencePrice,
  });

  return {
    traceId: input.traceId,
    executionId: input.executionId,
    orderId,
    status,
    avgPx,
    fillSize,
    fee,
    feeCcy: feeCcy == null ? null : String(feeCcy),
    slippage,
    slippageBps,
    orderDetail,
    fills,
    fillFetchError,
    fillUnavailableReason: fills.length === 0 ? fillFetchError || "OKX 未返回成交明细，fee/slippage 只能基于订单均价或显式为 null" : null,
  };
}

async function persistTradeFills(input: {
  userId: string;
  tradeOrderId: string;
  symbol: string;
  side: OrderSide;
  referencePrice: number | null;
  execution: Awaited<ReturnType<typeof loadExecutionDetails>>;
}) {
  if (input.execution.fills.length > 0) {
    for (const fill of input.execution.fills) {
      const fillPrice = toNumberOrNull(fill.fillPx);
      const fillSize = toNumberOrNull(fill.fillSz);
      const fee = toNumberOrNull(fill.fee);
      const { slippage, slippageBps } = calculateDirectionalSlippage({
        side: input.side,
        executedPrice: fillPrice,
        referencePrice: input.referencePrice,
      });
      await prisma.tradeFill.create({
        data: {
          traceId: input.execution.traceId,
          executionId: input.execution.executionId,
          userId: input.userId,
          tradeOrderId: input.tradeOrderId,
          symbol: input.symbol,
          fillPrice,
          fillSize,
          fee,
          feeCcy: fill.feeCcy == null ? null : String(fill.feeCcy),
          slippage,
          slippageBps,
          liquidity: fill.execType == null ? null : String(fill.execType),
          rawFill: fill as Prisma.InputJsonValue,
          filledAt: fill.ts ? new Date(Number(fill.ts)) : new Date(),
        },
      });
    }
    return;
  }

  if (input.execution.avgPx != null || input.execution.fillSize != null) {
    await prisma.tradeFill.create({
      data: {
        traceId: input.execution.traceId,
        executionId: input.execution.executionId,
        userId: input.userId,
        tradeOrderId: input.tradeOrderId,
        symbol: input.symbol,
        fillPrice: input.execution.avgPx,
        fillSize: input.execution.fillSize,
        fee: input.execution.fee,
        feeCcy: input.execution.feeCcy,
        slippage: input.execution.slippage,
        slippageBps: input.execution.slippageBps,
        liquidity: "order_summary",
        rawFill: {
          orderId: input.execution.orderId,
          orderDetail: input.execution.orderDetail,
          fillUnavailableReason: input.execution.fillUnavailableReason,
        } as Prisma.InputJsonValue,
      },
    });
  }
}

export async function runStrategy(symbol: string, strategyId?: string) {
  const round = nextTradeRound();
  const now = new Date().toISOString();
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) {
    return;
  }

  const strategy = strategyId
    ? await prisma.strategyConfig.findUnique({ where: { id: strategyId } })
    : await prisma.strategyConfig.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } });

  if (!strategy) {
    return;
  }

  const llm = await prisma.llmProviderConfig.findFirst({ where: { userId: user.id, isDefault: true } });
  if (!llm) {
    return;
  }

  const okxAccount = await prisma.exchangeAccount.findFirst({
    where: { userId: user.id, exchange: "okx", isDefault: true },
    orderBy: { updatedAt: "desc" },
  });

  const env: OkxEnv = okxAccount?.envType || "demo";
  const instId = normalizeInstId(symbol);
  const trace = createExecutionTrace(instId);
  const bar = strategy.timeframe === "15s" ? "1m" : strategy.timeframe || "5m";
  const minLeverage = Number.isFinite(strategy.minLeverage) ? strategy.minLeverage : 1;
  const maxLeverage = Number.isFinite(strategy.maxLeverage) ? strategy.maxLeverage : 3;
  const template = getPromptTemplate(llm.tradingPrompt || strategy.llmPromptTemplate);
  const requestedVariables = getEffectiveRequestedVariables(template);

  logTradeEvent("【OKX Pull request】", {
    success: true,
    flow: "host -> OKX",
    symbol: instId,
    traceId: trace.traceId,
    executionId: trace.executionId,
    requestData: {
      env,
      requestedVariables,
      fallbackVariablesApplied: extractTemplateVariables(template).length === 0,
      strategyTimeframe: strategy.timeframe,
    },
  }, round);

  let resolvedContext: ResolvedTemplateContext;
  try {
    resolvedContext = await resolveTemplateContext({
      template,
      instId,
      timeframe: strategy.timeframe,
      bar,
      env,
      userId: user.id,
      startedAt: strategy.createdAt,
      stopLossPct: strategy.stopLossPct,
      takeProfitPct: strategy.takeProfitPct,
    });

    logReadableJson("【OKX raw data for manual check】", {
      timestamp: new Date().toISOString(),
      symbol: instId,
      endpoints: resolvedContext.okxEndpoints,
      marketData3mOldestToNewest: resolvedContext.context.market_data ?? null,
      marketData4hOldestToNewest: resolvedContext.context.market_data_4h ?? null,
      fundingRateRaw: resolvedContext.context.funding_rate ?? null,
      openInterestRaw: resolvedContext.context.open_interest ?? null,
      balanceRaw: resolvedContext.context.balance ?? null,
      positionsRaw: resolvedContext.context.positions ?? null,
      openOrdersRaw: resolvedContext.context.open_orders ?? null,
    }, round);

    logTradeEvent("【OKX Pull response】", {
      success: true,
      flow: "host <- OKX",
      symbol: instId,
      responseData: {
        endpoints: resolvedContext.okxEndpoints,
        requestedVariables: resolvedContext.requestedVariables,
        unknownVariables: resolvedContext.unknownVariables,
        marketDataCount: Array.isArray(resolvedContext.context.market_data)
          ? resolvedContext.context.market_data.length
          : 0,
        latestCandle: extractLatestCandleSummary(resolvedContext.context.market_data),
        indicatorSummary: {
          ema20: numberFromUnknown(resolvedContext.context.ema_20, 0),
          ema50: numberFromUnknown(resolvedContext.context.ema_50, 0),
          rsi14: numberFromUnknown(resolvedContext.context.rsi_14, 0),
          atr14: numberFromUnknown(resolvedContext.context.atr_14, 0),
          hasMacd: Boolean(resolvedContext.context.macd),
          sharpeRatio: resolvedContext.context.sharpe_ratio ?? null,
        },
        hasBalance: Array.isArray(resolvedContext.context.balance)
          ? resolvedContext.context.balance.length > 0
          : Boolean(resolvedContext.context.balance),
        balanceFetchError: resolvedContext.context._balance_fetch_error || null,
        positionsFetchError: resolvedContext.context._positions_fetch_error || null,
      },
    }, round);
  } catch (error) {
    logTradeEvent("【OKX Pull response】", {
      success: false,
      flow: "host <- OKX",
      symbol: instId,
      responseData: {
        error: error instanceof Error ? error.message : String(error),
      },
    }, round);
    throw error;
  }

  const basePrompt = renderPrompt(template, resolvedContext.context);
  const prompt = `${basePrompt}\n${buildAccountPromptAppendix(resolvedContext.context)}`;

  logReadableJson("【computed user prompt for manual check】", {
    timestamp: new Date().toISOString(),
    symbol: instId,
    computedPlaceholders: buildPromptAuditLog(resolvedContext.context, resolvedContext.requestedVariables, prompt),
    userPrompt: prompt,
  }, round);

  await saveAccountSnapshot(user.id, resolvedContext.context);

  const llmStartedAt = Date.now();
  const llmRaw = await callLlmWithConfig(prompt, llm, round);
  const llmLatencyMs = Date.now() - llmStartedAt;
  let decision: ParsedDecision;
  try {
    decision = parseDecision(llmRaw, minLeverage, maxLeverage);
  } catch (error) {
    decision = {
      action: "hold",
      size: 0,
      leverage: minLeverage,
      reason: "LLM 返回不是合法 JSON 决策",
      confidence: 0,
      raw: { raw: llmRaw },
      validationErrors: [error instanceof Error ? error.message : String(error)],
    };
  }
  const decisionInstId = decision.targetInstId || instId;
  const symbolMismatchReason = decision.action === "hold"
    ? null
    : assertDecisionSymbolMatchesRunner(instId, decisionInstId);
  if (symbolMismatchReason) {
    decision.validationErrors.push(symbolMismatchReason);
  }

  const positionsForDecision = resolvedContext.context.positions || [];
  const finalAction = mapDecisionToOrderAction(decision, positionsForDecision, decisionInstId);
  const hasValidationErrors = decision.validationErrors.length > 0;
  const aiDecisionLog = await prisma.aiDecisionLog.create({
    data: {
      userId: user.id,
      modelName: llm.model,
      provider: llm.provider,
      inputPrompt: prompt,
      marketContext: {
        ...resolvedContext.context,
        traceId: trace.traceId,
        executionId: trace.executionId,
        runnerSymbol: instId,
      } as Prisma.InputJsonValue,
      modelOutputJson: {
        traceId: trace.traceId,
        executionId: trace.executionId,
        runnerSymbol: instId,
        rawText: llmRaw,
        raw: decision.raw,
        normalized: {
          action: decision.action,
          targetInstId: decisionInstId,
          size: decision.size,
          leverage: decision.leverage,
          confidence: decision.confidence,
          reason: decision.reason,
        },
        validationErrors: decision.validationErrors,
      } as Prisma.InputJsonValue,
      finalAction,
      confidence: Math.round(decision.confidence),
      blockedByRisk: hasValidationErrors,
      blockReason: hasValidationErrors ? decision.validationErrors.join("; ") : null,
      latencyMs: llmLatencyMs,
      errorMessage: hasValidationErrors ? "LLM 决策格式校验失败" : null,
    },
  });

  logTradeEvent("【LLM decision validation】", {
    success: !hasValidationErrors,
    flow: "host validation",
    symbol: decisionInstId,
    responseData: {
      decision: {
        action: decision.action,
        finalAction,
        size: decision.size,
        leverage: decision.leverage,
        confidence: decision.confidence,
        targetInstId: decisionInstId,
      },
      validationErrors: decision.validationErrors,
      aiDecisionLogId: aiDecisionLog.id,
    },
  }, round);

  const marketSnapshot = buildMarketSnapshotForOrder(resolvedContext.context, decisionInstId, trace) as Prisma.InputJsonValue;
  const accountSnapshotBefore = buildAccountSnapshotForOrder(resolvedContext.context, trace) as Prisma.InputJsonValue;
  const referencePrice = getReferencePriceForSymbol(resolvedContext.context, decisionInstId);

  if (hasValidationErrors) {
    await recordTradeOrder({
      traceId: trace.traceId,
      executionId: trace.executionId,
      userId: user.id,
      aiDecisionLogId: aiDecisionLog.id,
      env,
      symbol: decisionInstId,
      action: finalAction,
      side: sideForDecision(finalAction),
      status: "blocked",
      quantity: 0,
      price: referencePrice,
      orderResponse: { skipped: true, reason: "LLM 决策格式校验失败", validationErrors: decision.validationErrors },
      reasonSummary: "LLM 决策格式校验失败，未下单",
      reasonRaw: llmRaw,
      reasonTags: ["llm_validation_failed"],
      marketSnapshot,
      accountSnapshotBefore,
    });
    return;
  }

  if (decision.action === "hold") {
    logTradeEvent("【OKX exec request】", {
      success: true,
      flow: "host -> OKX",
      symbol: decisionInstId,
      requestData: {
        action: "hold",
        reason: "LLM 返回 hold，跳过下单",
      },
    }, round);
    logTradeEvent("【OKX exec response】", {
      success: true,
      flow: "host <- OKX",
      symbol: decisionInstId,
      responseData: {
        skipped: true,
        reason: "LLM 返回 hold，未执行下单",
      },
    }, round);
    return;
  }

  if (decision.action === "buy" || decision.action === "sell") {
    const duplicateReason = await hasDuplicateAction({
      userId: user.id,
      symbol: decisionInstId,
      action: decision.action,
      positions: positionsForDecision,
      env,
    });

    if (duplicateReason) {
      await prisma.aiDecisionLog.update({
        where: { id: aiDecisionLog.id },
        data: {
          blockedByRisk: true,
          blockReason: duplicateReason,
        },
      });
      logTradeEvent("【OKX exec request】", {
        success: true,
        flow: "host -> OKX",
        symbol: decisionInstId,
        requestData: {
          skipped: true,
          action: decision.action,
          reason: duplicateReason,
        },
      }, round);
      logTradeEvent("【OKX exec response】", {
        success: true,
        flow: "host <- OKX",
        symbol: decisionInstId,
        responseData: {
          skipped: true,
          reason: duplicateReason,
        },
      }, round);
      await recordTradeOrder({
        traceId: trace.traceId,
        executionId: trace.executionId,
        userId: user.id,
        aiDecisionLogId: aiDecisionLog.id,
        env,
        symbol: decisionInstId,
        action: finalAction,
        side: sideForDecision(finalAction),
        status: "blocked",
        quantity: decision.size,
        price: referencePrice,
        orderResponse: { skipped: true, reason: duplicateReason },
        reasonSummary: duplicateReason,
        reasonRaw: decision.reason,
        reasonTags: ["duplicate_guard"],
        marketSnapshot,
        accountSnapshotBefore,
      });
      return;
    }
  }

  if (decision.action === "close") {
    const closePlan = pickPositionToClose(decisionInstId, positionsForDecision);
    const minHoldCutoff = new Date(Date.now() - 15 * 60 * 1000);
    const recentOpenOrders = await prisma.tradeOrder.findMany({
      where: {
        userId: user.id,
        symbol: decisionInstId,
        action: { in: ["buy", "sell", "open_long", "open_short"] },
        status: { in: ["pending", "placed", "partially_filled", "filled"] },
        createdAt: { gte: minHoldCutoff },
      },
      orderBy: { createdAt: "desc" },
    });
    const minHoldBlock = findMinHoldCloseBlock({
      symbol: decisionInstId,
      action: finalAction,
      recentOrders: recentOpenOrders as RecentOrderLike[],
    });

    logTradeEvent("【OKX exec request】", {
      success: true,
      flow: "host -> OKX",
      symbol: decisionInstId,
      requestData: {
        closePosition: true,
        action: "close",
        closePlan,
      },
    }, round);

    if (!closePlan) {
      const reason = "未找到可平仓仓位";
      await prisma.aiDecisionLog.update({
        where: { id: aiDecisionLog.id },
        data: {
          blockedByRisk: true,
          blockReason: reason,
        },
      });
      logTradeEvent("【OKX exec response】", {
        success: true,
        flow: "host <- OKX",
        symbol: decisionInstId,
        responseData: {
          skipped: true,
          reason,
        },
      }, round);
      await recordTradeOrder({
        traceId: trace.traceId,
        executionId: trace.executionId,
        userId: user.id,
        aiDecisionLogId: aiDecisionLog.id,
        env,
        symbol: decisionInstId,
        action: finalAction,
        side: sideForDecision(finalAction),
        status: "blocked",
        quantity: 0,
        price: referencePrice,
        orderResponse: { skipped: true, reason },
        reasonSummary: reason,
        reasonRaw: decision.reason,
        reasonTags: ["close_without_position"],
        marketSnapshot,
        accountSnapshotBefore,
      });
      return;
    }

    if (minHoldBlock) {
      await prisma.aiDecisionLog.update({
        where: { id: aiDecisionLog.id },
        data: {
          blockedByRisk: true,
          blockReason: minHoldBlock,
        },
      });
      logTradeEvent("【OKX exec response】", {
        success: true,
        flow: "host <- OKX",
        symbol: decisionInstId,
        responseData: {
          skipped: true,
          reason: minHoldBlock,
        },
      }, round);
      await recordTradeOrder({
        traceId: trace.traceId,
        executionId: trace.executionId,
        userId: user.id,
        aiDecisionLogId: aiDecisionLog.id,
        env,
        symbol: decisionInstId,
        action: finalAction,
        side: sideForDecision(finalAction),
        status: "blocked",
        quantity: 0,
        price: referencePrice,
        orderResponse: { skipped: true, reason: minHoldBlock, traceId: trace.traceId, executionId: trace.executionId },
        reasonSummary: minHoldBlock,
        reasonRaw: decision.reason,
        reasonTags: ["min_hold_guard"],
        marketSnapshot,
        accountSnapshotBefore,
      });
      return;
    }

    try {
      const orderPayload = {
        instId: decisionInstId,
        tdMode: "cross" as const,
        side: closePlan.side,
        ordType: "market" as const,
        sz: closePlan.size,
        reduceOnly: true,
      };
      const orderResult = await okxAdapter.placeOrder(orderPayload, env);
      const execution = await loadExecutionDetails({
        env,
        symbol: decisionInstId,
        side: closePlan.side,
        orderResult,
        referencePrice,
        traceId: trace.traceId,
        executionId: trace.executionId,
      });
      const tradeOrder = await recordTradeOrder({
        traceId: trace.traceId,
        executionId: trace.executionId,
        userId: user.id,
        aiDecisionLogId: aiDecisionLog.id,
        env,
        symbol: decisionInstId,
        action: finalAction,
        side: closePlan.side,
        status: execution.status,
        quantity: execution.fillSize ?? Number(closePlan.size),
        price: execution.avgPx ?? referencePrice,
        fee: execution.fee,
        estimatedSlippage: execution.slippage,
        orderResponse: {
          traceId: trace.traceId,
          executionId: trace.executionId,
          orderRequestLog: {
            symbol: decisionInstId,
            side: closePlan.side,
            posSide: null,
            tdMode: orderPayload.tdMode,
            size: closePlan.size,
            leverage: decision.leverage,
            reduceOnly: true,
            payload: orderPayload,
          },
          orderResultLog: {
            orderId: execution.orderId,
            symbol: decisionInstId,
            status: execution.status,
            okxRawResponse: orderResult,
            errorMessage: execution.fillFetchError,
          },
          tradeFillLog: {
            symbol: decisionInstId,
            fillPrice: execution.avgPx,
            fillSize: execution.fillSize,
            fee: execution.fee,
            feeCcy: execution.feeCcy,
            slippage: execution.slippage,
            slippageBps: execution.slippageBps,
            timestamp: new Date().toISOString(),
            unavailableReason: execution.fillUnavailableReason,
          },
          orderPayload,
          orderResult,
          orderDetail: execution.orderDetail,
          fills: execution.fills,
        } as Prisma.InputJsonValue,
        reasonSummary: decision.reason,
        reasonRaw: decision.reason,
        reasonTags: ["ai_close", "reduce_only"],
        marketSnapshot,
        accountSnapshotBefore,
      });
      await persistTradeFills({
        userId: user.id,
        tradeOrderId: tradeOrder.id,
        symbol: decisionInstId,
        side: closePlan.side,
        referencePrice,
        execution,
      });
      logTradeEvent("【OKX exec response】", {
        success: true,
        flow: "host <- OKX",
        symbol: decisionInstId,
        responseData: {
          action: "close",
          traceId: trace.traceId,
          executionId: trace.executionId,
          orderId: execution.orderId,
          status: execution.status,
          fillPrice: execution.avgPx,
          fillSize: execution.fillSize,
          fee: execution.fee,
          feeCcy: execution.feeCcy,
          slippage: execution.slippage,
          slippageBps: execution.slippageBps,
          orderResult,
        },
      }, round);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await prisma.aiDecisionLog.update({
        where: { id: aiDecisionLog.id },
        data: {
          errorMessage,
        },
      });
      await recordTradeOrder({
        traceId: trace.traceId,
        executionId: trace.executionId,
        userId: user.id,
        aiDecisionLogId: aiDecisionLog.id,
        env,
        symbol: decisionInstId,
        action: finalAction,
        side: closePlan.side,
        status: "rejected",
        quantity: Number(closePlan.size),
        price: referencePrice,
        orderResponse: { error: errorMessage },
        reasonSummary: "OKX 平仓请求失败",
        reasonRaw: decision.reason,
        reasonTags: ["okx_error"],
        marketSnapshot,
        accountSnapshotBefore,
      });
      logTradeEvent("【OKX exec response】", {
        success: false,
        flow: "host <- OKX",
        symbol: decisionInstId,
        responseData: {
          action: "close",
          error: errorMessage,
        },
      }, round);
      throw error;
    }
    return;
  }

  const orderPayload = {
    instId: decisionInstId,
    tdMode: "cross" as const,
    side: decision.action as "buy" | "sell",
    ordType: "market" as const,
    sz: String(decision.size),
  };

  logTradeEvent("【OKX exec request】", {
    success: true,
    flow: "host -> OKX",
    symbol: decisionInstId,
    requestData: {
      setLeverage: {
        endpoint: "/api/v5/account/set-leverage",
        payload: {
          instId: decisionInstId,
          lever: decision.leverage,
          mgnMode: "cross",
        },
      },
      placeOrder: {
        endpoint: "/api/v5/trade/order",
        payload: orderPayload,
      },
    },
  }, round);

  try {
    const leverageResult = await okxAdapter.setLeverage(decisionInstId, decision.leverage, "cross", env);
    const orderResult = await okxAdapter.placeOrder(orderPayload, env);
    const execution = await loadExecutionDetails({
      env,
      symbol: decisionInstId,
      side: decision.action,
      orderResult,
      referencePrice,
      traceId: trace.traceId,
      executionId: trace.executionId,
    });
    const tradeOrder = await recordTradeOrder({
      traceId: trace.traceId,
      executionId: trace.executionId,
      userId: user.id,
      aiDecisionLogId: aiDecisionLog.id,
      env,
      symbol: decisionInstId,
      action: finalAction,
      side: decision.action,
      status: execution.status,
      quantity: execution.fillSize ?? decision.size,
      price: execution.avgPx ?? referencePrice,
      fee: execution.fee,
      estimatedSlippage: execution.slippage,
      orderResponse: {
        traceId: trace.traceId,
        executionId: trace.executionId,
        orderRequestLog: {
          symbol: decisionInstId,
          side: decision.action,
          posSide: decision.action === "buy" ? "long" : "short",
          tdMode: orderPayload.tdMode,
          size: orderPayload.sz,
          leverage: decision.leverage,
          reduceOnly: false,
          payload: orderPayload,
        },
        orderResultLog: {
          orderId: execution.orderId,
          symbol: decisionInstId,
          status: execution.status,
          okxRawResponse: orderResult,
          errorMessage: execution.fillFetchError,
        },
        tradeFillLog: {
          symbol: decisionInstId,
          fillPrice: execution.avgPx,
          fillSize: execution.fillSize,
          fee: execution.fee,
          feeCcy: execution.feeCcy,
          slippage: execution.slippage,
          slippageBps: execution.slippageBps,
          timestamp: new Date().toISOString(),
          unavailableReason: execution.fillUnavailableReason,
        },
        orderPayload,
        leverageResult,
        orderResult,
        orderDetail: execution.orderDetail,
        fills: execution.fills,
      } as Prisma.InputJsonValue,
      reasonSummary: decision.reason,
      reasonRaw: decision.reason,
      reasonTags: ["ai_order"],
      marketSnapshot,
      accountSnapshotBefore,
    });
    await persistTradeFills({
      userId: user.id,
      tradeOrderId: tradeOrder.id,
      symbol: decisionInstId,
      side: decision.action,
      referencePrice,
      execution,
    });
    logTradeEvent("【OKX exec response】", {
      success: true,
      flow: "host <- OKX",
      symbol: decisionInstId,
      responseData: {
        action: decision.action,
        traceId: trace.traceId,
        executionId: trace.executionId,
        orderId: execution.orderId,
        status: execution.status,
        fillPrice: execution.avgPx,
        fillSize: execution.fillSize,
        fee: execution.fee,
        feeCcy: execution.feeCcy,
        slippage: execution.slippage,
        slippageBps: execution.slippageBps,
        leverageResult,
        orderResult,
      },
    }, round);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await prisma.aiDecisionLog.update({
      where: { id: aiDecisionLog.id },
      data: {
        errorMessage,
      },
    });
    await recordTradeOrder({
      traceId: trace.traceId,
      executionId: trace.executionId,
      userId: user.id,
      aiDecisionLogId: aiDecisionLog.id,
      env,
      symbol: decisionInstId,
      action: finalAction,
      side: decision.action,
      status: "rejected",
      quantity: decision.size,
      price: referencePrice,
      orderResponse: { error: errorMessage },
      reasonSummary: "OKX 下单请求失败",
      reasonRaw: decision.reason,
      reasonTags: ["okx_error"],
      marketSnapshot,
      accountSnapshotBefore,
    });
    logTradeEvent("【OKX exec response】", {
      success: false,
      flow: "host <- OKX",
      symbol: decisionInstId,
      responseData: {
        action: decision.action,
        error: errorMessage,
      },
    }, round);
    throw error;
  }

  void now;
}

export async function runStrategyForSymbols(symbols: string[], strategyId?: string) {
  for (const symbol of symbols) {
    try {
      await runStrategy(symbol, strategyId);
    } catch {
      // Errors are already emitted in the six structured business logs.
    }
  }
}
