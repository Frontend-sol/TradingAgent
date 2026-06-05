import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EquityCurveChart } from "@/components/charts/equity-charts";
import { Button } from "@/components/ui/button";

async function getOverview() {
  const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/dashboard/overview`, {
    cache: "no-store",
  });
  const text = await response.text();
  if (!text) {
    return {
      metrics: null,
      equityCurve: [],
      latestTradingViewLogs: [],
      latestTrades: [],
      latestDecisions: [],
      okxStatus: { configured: false, message: "Dashboard API 返回空响应。" },
    };
  }
  try {
    return JSON.parse(text);
  } catch {
    return {
      metrics: null,
      equityCurve: [],
      latestTradingViewLogs: [],
      latestTrades: [],
      latestDecisions: [],
      okxStatus: { configured: false, message: "Dashboard API 返回了非 JSON 响应。" },
    };
  }
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

  const formatTime = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });

  const compactPayload = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return null;
    const row = payload as {
      signal?: { instId?: string; kind?: string; rawMessage?: string };
      action?: string;
      side?: string;
      quantity?: number;
      status?: string;
      error?: string;
      orderId?: string;
    };
    return {
      symbol: row.signal?.instId,
      kind: row.signal?.kind,
      action: row.action,
      side: row.side,
      quantity: row.quantity,
      status: row.status,
      error: row.error,
      orderId: row.orderId,
      rawMessage: row.signal?.rawMessage,
    };
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
          <CardTitle>收益 / 资金曲线</CardTitle>
        </CardHeader>
        <CardContent>
          <EquityCurveChart data={data.equityCurve || []} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>TradingView Webhook 日志</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {(data.latestTradingViewLogs || []).length ? (
            data.latestTradingViewLogs.map((item: { id: string; level: string; message: string; payload: unknown; createdAt: string }) => {
              const payload = compactPayload(item.payload);
              return (
                <div key={item.id} className="rounded border border-slate-800 bg-panel-soft p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium text-primary-text">{item.message}</div>
                    <div className={item.level === "error" ? "text-red-300" : item.level === "warn" ? "text-amber-300" : "text-emerald-300"}>
                      {item.level.toUpperCase()} · {formatTime(item.createdAt)}
                    </div>
                  </div>
                  {payload ? (
                    <div className="mt-2 grid gap-1 text-secondary-text md:grid-cols-4">
                      <div>标的：{payload.symbol || "--"}</div>
                      <div>信号：{payload.kind || "--"}</div>
                      <div>动作：{payload.action || payload.side || "--"}</div>
                      <div>状态：{payload.status || (payload.error ? "failed" : "--")}</div>
                    </div>
                  ) : null}
                  {payload?.rawMessage || payload?.error ? (
                    <div className="mt-2 rounded bg-black/20 px-2 py-1 text-xs text-slate-400">
                      {payload.error || payload.rawMessage}
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <div className="rounded border border-slate-800 p-3 text-secondary-text">
              暂无 TradingView webhook 信号。收到第一条警报后这里会显示解析和执行结果。
            </div>
          )}
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
