import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EquityCurveChart } from "@/components/charts/equity-charts";
import { Button } from "@/components/ui/button";

async function getOverview() {
  const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/dashboard/overview`, {
    cache: "no-store",
  });
  return response.json();
}

export default async function DashboardPage() {
  const data = await getOverview();
  const metrics = data.metrics || {
    equity: null,
    available: null,
    positionCount: 0,
    pnlToday: 0,
    pnlTotal: 0,
    dataSource: "fallback",
    strategyStatus: "stopped",
    aiStatus: "idle",
  };
  type MetricKey = "equity" | "available" | "positionCount" | "pnlToday" | "pnlTotal";
  const metricCards: Array<{ key: MetricKey; label: string }> = [
    { key: "equity", label: "账户总权益" },
    { key: "available", label: "可用余额" },
    { key: "positionCount", label: "持仓数量" },
    { key: "pnlToday", label: "今日盈亏" },
    { key: "pnlTotal", label: "累计盈亏" },
  ];

  const formatMetricValue = (key: MetricKey, value: number | null | undefined) => {
    if (value === null || value === undefined || Number.isNaN(value)) {
      return "--";
    }

    if (key === "positionCount") {
      return `${value}`;
    }

    return Number(value).toFixed(2);
  };

  return (
    <div className="space-y-6">
      {!data.okxStatus?.configured ? (
        <Card className="border-amber-400/40 bg-amber-500/10">
          <CardHeader>
            <CardTitle>请先同步 OKX 账户信息</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <p className="text-sm text-secondary-text">
              {data.okxStatus?.message || "尚未配置 OKX 账户，当前仅建议使用只读或模拟流程。"}
            </p>
            <a href="/settings">
              <Button>前往系统配置</Button>
            </a>
          </CardContent>
        </Card>
      ) : null}

      {data.okxStatus?.configured ? (
        <Card className="border-border bg-panel-soft">
          <CardContent className="py-4 text-sm text-secondary-text">
            <p>{data.okxStatus?.message}</p>
            <p className="mt-1">
              数据来源：{metrics.dataSource === "okx" ? "OKX 实时接口" : "本地回退（实时数据暂不可用）"}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        {metricCards.map((item) => (
          <Card key={item.key}>
            <CardHeader>
              <CardTitle>{item.label}</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatMetricValue(item.key, metrics[item.key])}</CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>资金曲线</CardTitle>
        </CardHeader>
        <CardContent>
          <EquityCurveChart data={data.equityCurve || []} />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>最近信号</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {(data.latestDecisions || []).slice(0, 6).map((item: { id: string; finalAction: string; confidence: number; createdAt: string }) => (
              <div key={item.id} className="rounded border border-slate-800 p-2">
                <div>{item.finalAction}</div>
                <div className="text-slate-400">confidence: {item.confidence}</div>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>最近成交</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {(data.latestTrades || []).slice(0, 6).map((item: { id: string; symbol: string; action: string; status: string }) => (
              <div key={item.id} className="rounded border border-slate-800 p-2">
                <div>{item.symbol} · {item.action}</div>
                <div className="text-slate-400">{item.status}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
