"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const primaryItems = [{ href: "/dashboard", label: "Dashboard" }];

const configItems = [
  { href: "/settings", label: "系统配置（LLM + OKX）" },
  { href: "/trading-config", label: "交易配置" },
];

const logItems = [
  { href: "/trade-logs", label: "交易日志" },
  { href: "/ai-logs", label: "AI 决策日志" },
];

const runtimeItems = [
  { href: "/realtime", label: "实时交易" },
  { href: "/performance", label: "绩效分析" },
  { href: "/risk-center", label: "风控中心" },
];

function NavGroup({
  title,
  items,
  pathname,
}: {
  title: string;
  items: Array<{ href: string; label: string }>;
  pathname: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-panel p-2">
      <div className="px-2 pb-1 pt-1 text-xs font-medium uppercase tracking-wide text-secondary-text">{title}</div>
      <div className="space-y-1">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "block rounded-md px-3 py-2 text-base text-secondary-text hover:bg-panel-soft",
              pathname === item.href && "bg-panel-soft text-brand",
            )}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 border-r border-border bg-panel-soft p-4">
      <div className="mb-4 rounded-lg bg-emerald-500/10 p-3 text-emerald-300">
        <div className="text-sm">OKX Environment</div>
        <div className="text-base font-semibold">DEMO / SIMULATED</div>
      </div>
      <nav className="space-y-3">
        <NavGroup title="总览" items={primaryItems} pathname={pathname} />
        <NavGroup title="配置中心" items={configItems} pathname={pathname} />
        <NavGroup title="日志中心" items={logItems} pathname={pathname} />
        <NavGroup title="运行监控" items={runtimeItems} pathname={pathname} />
      </nav>
    </aside>
  );
}
