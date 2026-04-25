"use client";

import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type TradeLogRow = {
  id: string;
  symbol: string;
  action: string;
  side: string;
  price: number | null;
  quantity: number;
  fee: number | null;
  estimatedSlippage: number | null;
  status: string;
  traceId: string | null;
  triggerSource: string;
  aiDecisionSummary: string | null;
  orderResponse: unknown;
  fills?: Array<{
    fillPrice: number | null;
    fillSize: number | null;
    fee: number | null;
    feeCcy: string | null;
    slippage: number | null;
    slippageBps: number | null;
  }>;
  createdAt: string;
  aiDecision?: {
    blockedByRisk: boolean;
    blockReason: string | null;
    errorMessage: string | null;
  } | null;
};

type Pagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

function formatJsonPreview(value: unknown) {
  if (!value) return "-";
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

function formatFillPreview(row: TradeLogRow) {
  const firstFill = row.fills?.[0];
  if (!firstFill) {
    return `fee=${formatNumber(row.fee)} slip=${formatNumber(row.estimatedSlippage)}`;
  }
  return [
    `px=${formatNumber(firstFill.fillPrice)}`,
    `sz=${formatNumber(firstFill.fillSize)}`,
    `fee=${formatNumber(firstFill.fee)} ${firstFill.feeCcy || ""}`.trim(),
    `slip=${formatNumber(firstFill.slippage)} (${formatNumber(firstFill.slippageBps)}bps)`,
  ].join(" / ");
}

function formatNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "-";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 8 });
}

export function TradeLogTable() {
  const [rows, setRows] = useState<TradeLogRow[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, pageSize: 50, total: 0, totalPages: 0 });
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const loadPage = async (page = pagination.page) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/trades?page=${page}&pageSize=${pagination.pageSize}`, { cache: "no-store" });
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
      rows.filter(
        (row) =>
          row.symbol.toLowerCase().includes(query.toLowerCase()) ||
          row.action.toLowerCase().includes(query.toLowerCase()) ||
          row.status.toLowerCase().includes(query.toLowerCase()),
      ),
    [query, rows],
  );

  const clearLogs = async () => {
    if (!window.confirm("确认清空所有交易日志？该操作会删除数据库中的交易订单和成交记录。")) return;
    await fetch("/api/trades", { method: "DELETE" });
    await loadPage(1);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <Input className="md:max-w-sm" placeholder="搜索标的/动作/状态" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => window.open("/api/trades/export", "_blank")}>导出 CSV</Button>
          <Button variant="outline" onClick={clearLogs}>清空日志</Button>
        </div>
      </div>
      <div className="overflow-auto rounded-md border border-slate-800">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-900 text-slate-300">
            <tr>
              <th className="px-3 py-2 text-left">时间</th>
              <th className="px-3 py-2 text-left">标的</th>
              <th className="px-3 py-2 text-left">动作</th>
              <th className="px-3 py-2 text-left">方向</th>
              <th className="px-3 py-2 text-right">价格</th>
              <th className="px-3 py-2 text-right">数量</th>
              <th className="px-3 py-2 text-left">成交/费用/滑点</th>
              <th className="px-3 py-2 text-left">订单状态</th>
              <th className="px-3 py-2 text-left">Trace</th>
              <th className="px-3 py-2 text-left">触发来源</th>
              <th className="px-3 py-2 text-left">AI格式</th>
              <th className="px-3 py-2 text-left">AI 摘要</th>
              <th className="px-3 py-2 text-left">交易所响应</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.id} className="border-t border-slate-800">
                <td className="px-3 py-2 whitespace-nowrap">{new Date(row.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2">{row.symbol}</td>
                <td className="px-3 py-2">{row.action}</td>
                <td className="px-3 py-2">{row.side}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.price)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.quantity)}</td>
                <td className="px-3 py-2 max-w-sm text-xs">{formatFillPreview(row)}</td>
                <td className="px-3 py-2">{row.status}</td>
                <td className="px-3 py-2 max-w-[10rem] truncate text-xs" title={row.traceId || ""}>{row.traceId || "-"}</td>
                <td className="px-3 py-2">{row.triggerSource}</td>
                <td className="px-3 py-2">
                  {row.aiDecision?.blockedByRisk ? row.aiDecision.blockReason || row.aiDecision.errorMessage || "blocked" : "ok"}
                </td>
                <td className="px-3 py-2 max-w-sm">{row.aiDecisionSummary || "-"}</td>
                <td className="px-3 py-2 max-w-sm break-words">{formatJsonPreview(row.orderResponse)}</td>
              </tr>
            ))}
            {!loading && filtered.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-secondary-text" colSpan={14}>暂无交易日志</td>
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
    </div>
  );
}
