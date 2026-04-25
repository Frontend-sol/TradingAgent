"use client";

import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { useRealtimeStore } from "@/store/realtime-store";

export function Topbar() {
  const { runtimeMode, autoTradingEnabled, riskEnabled, latestSignal } = useRealtimeStore();

  return (
    <header className="flex items-center justify-between border-b border-border bg-panel-soft px-6 py-3">
      <div>
        <h1 className="text-base font-semibold text-primary-text">AutoTrading Workbench</h1>
        <p className="text-sm text-secondary-text">AI 辅助决策 + 自动执行 + 全链路复盘</p>
      </div>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <Badge tone="warning">Mode: {runtimeMode}</Badge>
        <Badge tone={autoTradingEnabled ? "success" : "neutral"}>Auto: {autoTradingEnabled ? "ON" : "OFF"}</Badge>
        <Badge tone={riskEnabled ? "success" : "danger"}>Risk: {riskEnabled ? "ON" : "OFF"}</Badge>
        <Badge tone="neutral">Signal: {latestSignal}</Badge>
      </div>
    </header>
  );
}
