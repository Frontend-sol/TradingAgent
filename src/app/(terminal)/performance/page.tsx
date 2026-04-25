import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EquityCurveChart, DailyPnlChart } from "@/components/charts/equity-charts";

async function getPerformance() {
  const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/performance`, {
    cache: "no-store",
  });
  return response.json();
}

export default async function PerformancePage() {
  const data = await getPerformance();
  const stats = data.stats;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-6">
        {[
          ["胜率", `${stats.winRate}%`],
          ["盈亏比", stats.profitFactor],
          ["最大回撤", `${stats.maxDrawdown}%`],
          ["夏普比率", stats.sharpe],
          ["交易次数", stats.trades],
          ["手续费", stats.feeTotal],
        ].map(([label, value]) => (
          <Card key={String(label)}>
            <CardHeader>
              <CardTitle>{label}</CardTitle>
            </CardHeader>
            <CardContent className="text-xl font-semibold">{value}</CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>资金曲线 / 收益率曲线</CardTitle>
        </CardHeader>
        <CardContent>
          <EquityCurveChart data={data.equityCurve} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>单日盈亏柱状图</CardTitle>
        </CardHeader>
        <CardContent>
          <DailyPnlChart data={data.equityCurve} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>标的贡献分析</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 md:grid-cols-3 text-sm">
            {data.symbolContribution.map((item: any) => (
              <div key={item.symbol} className="rounded border border-slate-800 p-3">
                <div>{item.symbol}</div>
                <div className={item.pnl >= 0 ? "text-emerald-300" : "text-red-300"}>{item.pnl}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
