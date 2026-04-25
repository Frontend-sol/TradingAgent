import { NextResponse } from "next/server";
import { generateEquityCurve } from "@/lib/mock-data";

export async function GET() {
  const equityCurve = generateEquityCurve(90);
  const wins = equityCurve.filter((d) => d.pnl > 0).length;
  const losses = equityCurve.filter((d) => d.pnl < 0).length;
  const winRate = wins + losses === 0 ? 0 : Number(((wins / (wins + losses)) * 100).toFixed(2));
  const maxDrawdown = Math.max(...equityCurve.map((d) => d.drawdown));

  return NextResponse.json({
    equityCurve,
    stats: {
      trades: 123,
      winRate,
      profitFactor: 1.42,
      maxDrawdown,
      sharpe: 1.08,
      feeTotal: 93.3,
      slippageAvg: 1.8,
    },
    symbolContribution: [
      { symbol: "BTC-USDT-SWAP", pnl: 420.5 },
      { symbol: "ETH-USDT-SWAP", pnl: -132.7 },
      { symbol: "BTC-USDT", pnl: 76.2 },
    ],
    longShortDistribution: [
      { name: "Long", value: 68 },
      { name: "Short", value: 55 },
    ],
    holdingDurationDistribution: [
      { bucket: "<15m", count: 10 },
      { bucket: "15m-1h", count: 38 },
      { bucket: "1h-4h", count: 49 },
      { bucket: ">4h", count: 26 },
    ],
  });
}
