import { subDays, format } from "date-fns";

export function generateEquityCurve(days = 30) {
  const data: Array<{ date: string; equity: number; drawdown: number; pnl: number }> = [];
  let equity = 10000;
  let peak = equity;

  for (let index = days - 1; index >= 0; index -= 1) {
    const delta = (Math.random() - 0.45) * 220;
    equity += delta;
    peak = Math.max(peak, equity);
    data.push({
      date: format(subDays(new Date(), index), "MM-dd"),
      equity: Number(equity.toFixed(2)),
      drawdown: Number((((peak - equity) / peak) * 100).toFixed(2)),
      pnl: Number(delta.toFixed(2)),
    });
  }

  return data;
}

export const mockRealtimeTicker = {
  instId: "BTC-USDT-SWAP",
  last: "66520.1",
  change24h: "1.82",
  vol24h: "12345",
};
