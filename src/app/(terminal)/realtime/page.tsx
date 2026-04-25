"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useRealtimeStore } from "@/store/realtime-store";

type MarketCard = {
  symbol: string;
  last: string;
  change24h: number;
  change24hText: string;
  vol24h: string;
};

type PositionCard = {
  symbol: string;
  side: string;
  size: string;
  leverage: string;
  avgPx: string;
  markPx: string;
  upl: number;
  uplText: string;
  uplRatio: number;
  uplRatioText: string;
};

type RealtimeSnapshot = {
  ts: number;
  env?: string;
  error?: string;
  marketCards: MarketCard[];
  positionCards: PositionCard[];
  summary: {
    equity: string;
    usdtAvailable: string;
    openPositions: number;
    totalUpl: number;
    totalUplText: string;
  };
};

export default function RealtimePage() {
  const [snapshot, setSnapshot] = useState<RealtimeSnapshot | null>(null);
  const [logs, setLogs] = useState<Array<string>>([]);
  const [streamError, setStreamError] = useState<string>("");
  const { update, autoTradingEnabled, riskEnabled, latestSignal } = useRealtimeStore();

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onmessage = (event) => {
      const data = JSON.parse(event.data) as RealtimeSnapshot;
      setSnapshot(data);
      setStreamError(data.error || "");

      const topMover = [...(data.marketCards || [])].sort(
        (a, b) => Math.abs(b.change24h) - Math.abs(a.change24h),
      )[0];

      update({
        autoTradingEnabled: data.summary.openPositions > 0,
        riskEnabled: !(data.error || ""),
        latestSignal: topMover
          ? `${topMover.symbol} ${topMover.change24h >= 0 ? "UP" : "DOWN"} ${topMover.change24hText}`
          : "hold",
      });

      setLogs((prev) => [
        `${new Date(data.ts).toLocaleTimeString()} | env=${data.env || "demo"} | 持仓=${data.summary.openPositions} | 总浮盈=${data.summary.totalUplText}`,
        ...prev,
      ].slice(0, 20));
    };

    source.onerror = () => {
      setStreamError("实时流连接中断，请检查服务状态");
    };

    return () => source.close();
  }, [update]);

  const handleManualOrder = async (side: "buy" | "sell") => {
    await fetch("/api/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: "BTC-USDT-SWAP", side, quantity: 0.01 }),
    });
    alert(`已提交${side}订单`);
  };

  const handleRunDecision = async () => {
    await fetch("/api/decision/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: "BTC-USDT-SWAP", timeframe: "15m", execute: false }),
    });
    alert("已触发 AI 分析（仅分析）");
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>实时交易控制台</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="warning">DEMO</Badge>
            <Badge tone={autoTradingEnabled ? "success" : "neutral"}>自动交易 {autoTradingEnabled ? "ON" : "OFF"}</Badge>
            <Badge tone={riskEnabled ? "success" : "danger"}>风控 {riskEnabled ? "ON" : "OFF"}</Badge>
            <Badge tone="neutral">最新信号 {latestSignal}</Badge>
          </div>
          {streamError ? (
            <div className="rounded-md border border-rose-800 bg-rose-950/30 p-3 text-sm text-rose-200">
              {streamError}
            </div>
          ) : null}

          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-md border border-slate-800 p-3">
              <div className="text-xs text-slate-400">账户权益</div>
              <div className="text-xl font-semibold">{snapshot?.summary.equity || "-"}</div>
            </div>
            <div className="rounded-md border border-slate-800 p-3">
              <div className="text-xs text-slate-400">USDT 可用</div>
              <div className="text-xl font-semibold">{snapshot?.summary.usdtAvailable || "-"}</div>
            </div>
            <div className="rounded-md border border-slate-800 p-3">
              <div className="text-xs text-slate-400">持仓数量</div>
              <div className="text-xl font-semibold">{snapshot?.summary.openPositions ?? 0}</div>
            </div>
            <div className="rounded-md border border-slate-800 p-3">
              <div className="text-xs text-slate-400">总浮盈</div>
              <div className={`text-xl font-semibold ${(snapshot?.summary.totalUpl ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                {snapshot?.summary.totalUplText || "0"}
              </div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {(snapshot?.marketCards || []).map((item) => (
              <div key={item.symbol} className="rounded-md border border-slate-800 p-3">
                <div className="text-xs text-slate-400">{item.symbol}</div>
                <div className="mt-1 text-lg font-semibold">{item.last}</div>
                <div className={`text-sm ${item.change24h >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                  24h {item.change24hText}
                </div>
                <div className="text-xs text-slate-500">Vol24h {item.vol24h}</div>
              </div>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(snapshot?.positionCards || []).length === 0 ? (
              <div className="rounded-md border border-slate-800 p-3 text-sm text-slate-400">
                当前无主流币持仓
              </div>
            ) : (
              (snapshot?.positionCards || []).map((item) => (
                <div key={`${item.symbol}-${item.side}`} className="rounded-md border border-slate-800 p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold">{item.symbol}</div>
                    <Badge tone="neutral">{item.side}</Badge>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-300">
                    <div>数量: {item.size}</div>
                    <div>杠杆: {item.leverage}x</div>
                    <div>开仓均价: {item.avgPx}</div>
                    <div>标记价格: {item.markPx}</div>
                  </div>
                  <div className={`mt-2 text-sm font-medium ${item.upl >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                    浮盈: {item.uplText} ({item.uplRatioText})
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => handleManualOrder("buy")}>手动买入</Button>
            <Button variant="secondary" onClick={() => handleManualOrder("sell")}>手动卖出</Button>
            <Button variant="outline" onClick={handleRunDecision}>一键仅分析不下单</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>实时事件流</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="max-h-80 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-300">
            {logs.map((line, index) => (
              <div key={`${line}-${index}`}>{line}</div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
