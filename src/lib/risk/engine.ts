import type { RiskConfig } from "@prisma/client";

export interface RiskCheckInput {
  symbol: string;
  expectedOrderValue: number;
  accountEquity: number;
  dailyPnl: number;
  drawdownPct: number;
  consecutiveLosses: number;
  volatilityPct: number;
}

export interface RiskCheckResult {
  pass: boolean;
  reasons: string[];
}

export function runRiskChecks(config: RiskConfig, input: RiskCheckInput): RiskCheckResult {
  const reasons: string[] = [];

  if (config.killSwitchEnabled) reasons.push("Kill Switch 已开启");
  if (input.expectedOrderValue > config.maxSingleOrderValue) reasons.push("超过单笔下单金额上限");
  if (input.expectedOrderValue > config.maxPositionValue) reasons.push("超过最大仓位限制");
  if (Math.abs(input.dailyPnl) > config.maxDailyLoss && input.dailyPnl < 0) reasons.push("超过最大日亏损阈值");
  if (input.drawdownPct > config.maxDrawdownPct) reasons.push("超过最大回撤阈值");
  if (input.consecutiveLosses >= config.maxConsecutiveLosses) reasons.push("触发连续亏损停止交易");
  if (config.highVolatilityPause && input.volatilityPct > config.volatilityThreshold) reasons.push("波动率过高，暂停交易");

  if (config.whitelistSymbols.length && !config.whitelistSymbols.includes(input.symbol)) {
    reasons.push("不在白名单标的中");
  }
  if (config.blacklistSymbols.includes(input.symbol)) {
    reasons.push("命中黑名单标的");
  }

  return {
    pass: reasons.length === 0,
    reasons,
  };
}
