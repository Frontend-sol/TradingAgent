"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type TradingViewLogRow = {
  id: string;
  level: string;
  message: string;
  payload: unknown;
  createdAt: string;
};

type Pagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

function asRecord(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function getSignal(row: TradingViewLogRow) {
  return asRecord(asRecord(row.payload).signal);
}

function preview(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "-";
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function formatNumber(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(number)) return "-";
  return number.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

export function TradingViewLogTable() {
  const [rows, setRows] = useState<TradingViewLogRow[]>([]);
  const [selected, setSelected] = useState<TradingViewLogRow | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, pageSize: 50, total: 0, totalPages: 0 });

  const loadPage = async (page = pagination.page) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/tradingview-logs?page=${page}&pageSize=${pagination.pageSize}`, { cache: "no-store" });
      const result = await response.json();
      setRows(result.data || []);
      setPagination(result.pagination || { page, pageSize: 50, total: 0, totalPages: 0 });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadPage(1);
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(
    () =>
      rows.filter((row) => {
        const signal = getSignal(row);
        const payload = asRecord(row.payload);
        const haystack = [row.level, row.message, signal.kind, signal.symbol, signal.instId, signal.rawMessage, payload.error]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(query.toLowerCase());
      }),
    [query, rows],
  );

  const clearLogs = async () => {
    if (!window.confirm("确认清空所有 TradingView 日志？")) return;
    await fetch("/api/tradingview-logs", { method: "DELETE" });
    setSelected(null);
    await loadPage(1);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <Input className="md:max-w-sm" placeholder="搜索信号/标的/状态/错误" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => window.open("/api/tradingview-logs/export", "_blank")}>导出 CSV</Button>
          <Button variant="outline" onClick={clearLogs}>清空日志</Button>
        </div>
      </div>

      <div className="overflow-auto rounded-md border border-slate-800">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-900 text-slate-300">
            <tr>
              <th className="px-3 py-2 text-left">时间</th>
              <th className="px-3 py-2 text-left">级别</th>
              <th className="px-3 py-2 text-left">事件</th>
              <th className="px-3 py-2 text-left">信号</th>
              <th className="px-3 py-2 text-left">标的</th>
              <th className="px-3 py-2 text-right">价格</th>
              <th className="px-3 py-2 text-right">数量</th>
              <th className="px-3 py-2 text-left">状态</th>
              <th className="px-3 py-2 text-left">详情</th>
              <th className="px-3 py-2 text-left">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const payload = asRecord(row.payload);
              const signal = getSignal(row);
              const sizing = asRecord(payload.sizing);
              return (
                <tr key={row.id} className="border-t border-slate-800 align-top">
                  <td className="whitespace-nowrap px-3 py-2">{new Date(row.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-2">{row.level}</td>
                  <td className="px-3 py-2">{row.message}</td>
                  <td className="px-3 py-2">{String(signal.kind ?? "-")}</td>
                  <td className="px-3 py-2">{String(signal.instId ?? signal.symbol ?? "-")}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(signal.closePrice)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(payload.quantity ?? sizing.quantity)}</td>
                  <td className="px-3 py-2">{String(payload.status ?? payload.error ?? "-")}</td>
                  <td className="max-w-xl px-3 py-2 text-secondary-text">{preview(payload.error ?? signal.rawMessage ?? row.payload)}</td>
                  <td className="px-3 py-2">
                    <Button variant="outline" onClick={() => setSelected(row)}>查看</Button>
                  </td>
                </tr>
              );
            })}
            {!loading && filtered.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-secondary-text" colSpan={10}>暂无 TradingView 日志</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-secondary-text">
        <span>共 {pagination.total} 条，每页 {pagination.pageSize} 条</span>
        <div className="flex items-center gap-2">
          <Button variant="outline" disabled={pagination.page <= 1 || loading} onClick={() => loadPage(pagination.page - 1)}>上一页</Button>
          <span>第 {pagination.page} / {Math.max(1, pagination.totalPages)} 页</span>
          <Button variant="outline" disabled={pagination.page >= pagination.totalPages || loading} onClick={() => loadPage(pagination.page + 1)}>下一页</Button>
        </div>
      </div>

      {selected ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="flex max-h-[85vh] w-full max-w-5xl flex-col rounded-lg border border-border bg-panel shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-primary-text">TradingView 日志详情</p>
                <p className="text-xs text-secondary-text">{new Date(selected.createdAt).toLocaleString()} · {selected.level}</p>
              </div>
              <Button variant="outline" onClick={() => setSelected(null)}>关闭</Button>
            </div>
            <pre className="overflow-auto p-4 text-xs leading-5 text-slate-200">{JSON.stringify(selected, null, 2)}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
