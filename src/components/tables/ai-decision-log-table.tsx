"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type AiDecisionRow = {
  id: string;
  modelName: string;
  provider: string;
  modelOutputJson: unknown;
  finalAction: string;
  confidence: number;
  blockedByRisk: boolean;
  blockReason: string | null;
  errorMessage: string | null;
  createdAt: string;
  tradeOrders?: Array<{ id: string; symbol: string; status: string; price: number | null; quantity: number }>;
};

type Pagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

function getFullOutput(row: AiDecisionRow) {
  const output = row.modelOutputJson as { rawText?: unknown; raw?: unknown; normalized?: unknown; validationErrors?: unknown } | null;
  return JSON.stringify(
    {
      rawText: output?.rawText ?? null,
      rawOutput: output?.raw ?? row.modelOutputJson,
      normalized: output?.normalized ?? null,
      validationErrors: output?.validationErrors ?? null,
      blockReason: row.blockReason,
      errorMessage: row.errorMessage,
      tradeOrders: row.tradeOrders || [],
    },
    null,
    2,
  );
}

function preview(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "-";
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

export function AiDecisionLogTable() {
  const [rows, setRows] = useState<AiDecisionRow[]>([]);
  const [selected, setSelected] = useState<AiDecisionRow | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, pageSize: 50, total: 0, totalPages: 0 });

  const loadPage = async (page = pagination.page) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/ai-decisions?page=${page}&pageSize=${pagination.pageSize}`, { cache: "no-store" });
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
          row.modelName.toLowerCase().includes(query.toLowerCase()) ||
          row.finalAction.toLowerCase().includes(query.toLowerCase()) ||
          (row.blockReason || "").toLowerCase().includes(query.toLowerCase()),
      ),
    [query, rows],
  );

  const clearLogs = async () => {
    if (!window.confirm("确认清空所有 AI 决策日志？该操作会删除数据库中的 AI 决策记录，并解除交易日志的关联。")) return;
    await fetch("/api/ai-decisions", { method: "DELETE" });
    setSelected(null);
    await loadPage(1);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <Input className="md:max-w-sm" placeholder="搜索模型/动作/拦截原因" value={query} onChange={(event) => setQuery(event.target.value)} />
        <Button variant="outline" onClick={clearLogs}>清空日志</Button>
      </div>

      <div className="overflow-auto rounded-md border border-slate-800">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-900 text-slate-300">
            <tr>
              <th className="px-3 py-2 text-left">时间</th>
              <th className="px-3 py-2 text-left">模型</th>
              <th className="px-3 py-2 text-left">动作</th>
              <th className="px-3 py-2 text-right">置信度</th>
              <th className="px-3 py-2 text-left">状态</th>
              <th className="px-3 py-2 text-left">AI 输出预览</th>
              <th className="px-3 py-2 text-left">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.id} className="border-t border-slate-800 align-top">
                <td className="px-3 py-2 whitespace-nowrap">{new Date(row.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2">{row.provider} · {row.modelName}</td>
                <td className="px-3 py-2">{row.finalAction}</td>
                <td className="px-3 py-2 text-right tabular-nums">{row.confidence}</td>
                <td className="px-3 py-2">{row.blockedByRisk ? row.blockReason || row.errorMessage || "blocked" : "ok"}</td>
                <td className="px-3 py-2 max-w-xl text-secondary-text">{preview((row.modelOutputJson as { rawText?: unknown; raw?: unknown } | null)?.rawText ?? (row.modelOutputJson as { raw?: unknown } | null)?.raw ?? row.modelOutputJson)}</td>
                <td className="px-3 py-2">
                  <Button variant="outline" onClick={() => setSelected(row)}>查看完整内容</Button>
                </td>
              </tr>
            ))}
            {!loading && filtered.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-secondary-text" colSpan={7}>暂无 AI 决策日志</td>
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
                <p className="text-sm font-semibold text-primary-text">AI 分析完整内容</p>
                <p className="text-xs text-secondary-text">{selected.provider} · {selected.modelName} · {new Date(selected.createdAt).toLocaleString()}</p>
              </div>
              <Button variant="outline" onClick={() => setSelected(null)}>关闭</Button>
            </div>
            <pre className="overflow-auto p-4 text-xs leading-5 text-slate-200">{getFullOutput(selected)}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
