"use client";

import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

const symbolOptions = [
  "BTC-USDT",
  "ETH-USDT",
  "SOL-USDT",
  "XRP-USDT",
  "BNB-USDT",
  "DOGE-USDT",
  "ADA-USDT",
  "AVAX-USDT",
  "LINK-USDT",
  "DOT-USDT",
  "TRX-USDT",
  "LTC-USDT",
  "BCH-USDT",
  "UNI-USDT",
  "AAVE-USDT",
  "APT-USDT",
  "ARB-USDT",
  "OP-USDT",
  "SUI-USDT",
  "NEAR-USDT",
  "FIL-USDT",
  "ETC-USDT",
  "ATOM-USDT",
  "INJ-USDT",
  "PEPE-USDT",
  "WIF-USDT",
  "SHIB-USDT",
] as const;
const MASK_PLACEHOLDER = "********";
const MAX_PROMPTS_PER_TYPE = 4;

const defaultTradingPrompt = [
  "你是交易决策引擎，请严格输出 JSON，不要输出额外文本。",
  "symbol: {{symbol}}",
  "time: {{timestamp}}",
  "balance: {{balance}}",
  "market: {{market_data}}",
  "返回格式: {\"action\":\"buy|sell|hold\",\"size\":1,\"leverage\":3,\"reason\":\"...\"}",
].join("\n");

const defaultSystemPrompt = "You are a strict crypto quantitative analyst.";
const defaultDecisionSchema = {
  action: "buy | sell | hold | close_long | close_short | open_long | open_short",
  confidence: "0-100",
  reason_summary: "一句话摘要",
};

const schema = z.object({
  timeframe: z.enum(["15s", "1m", "3m", "5m", "15m", "1h"]),
  minLeverage: z.number().min(1).max(100),
  maxLeverage: z.number().min(1).max(100),
  symbols: z.array(z.string()).min(1),
  autoTradingEnabled: z.boolean(),
  enableAiListener: z.boolean(),
  enableTradingviewListener: z.boolean(),
  tradingviewMode: z.enum(["paper", "live"]),
  tradingviewLeverage: z.number().min(1).max(15),
  tradingviewOpenBalancePct: z.number().min(1).max(100),
  tradingviewStopLossPct: z.number().min(0.1).max(30),
  llmPromptTemplate: z.string().min(1),
});

type FormValues = z.infer<typeof schema>;
type PromptType = "system" | "user";

interface PromptTemplate {
  id: string;
  name: string;
  content: string;
  promptType: PromptType;
  isDefault: boolean;
}

interface PromptEditorState {
  open: boolean;
  id: string | null;
  promptType: PromptType;
  name: string;
  content: string;
  isDefault: boolean;
}

interface SystemConfigSnapshot {
  llm: {
    provider: string;
    model: string;
    apiKeyMasked: string;
    baseUrl: string;
    temperature: number;
    maxTokens: number;
    decisionSchema: Record<string, unknown>;
    secondaryConfirmation: boolean;
    multiModelVoting: boolean;
    structuredReasonOutput: boolean;
  } | null;
  okx: {
    label: string;
    envType: "demo" | "live";
    apiKeyMasked: string;
    hasSecret: boolean;
    hasPassphrase: boolean;
    readOnly: boolean;
    enableAutoTrading: boolean;
  } | null;
}

export default function TradingConfigPage() {
  const [statusText, setStatusText] = useState("任务未启动");
  const [busy, setBusy] = useState(false);
  const [systemConfig, setSystemConfig] = useState<SystemConfigSnapshot>({ llm: null, okx: null });
  const [systemPrompt, setSystemPrompt] = useState(defaultSystemPrompt);
  const [userPrompt, setUserPrompt] = useState(defaultTradingPrompt);
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplate[]>([]);
  const [promptLoading, setPromptLoading] = useState(false);
  const [activePromptIds, setActivePromptIds] = useState<{ system: string | null; user: string | null }>({
    system: null,
    user: null,
  });
  const [promptEditor, setPromptEditor] = useState<PromptEditorState>({
    open: false,
    id: null,
    promptType: "system",
    name: "",
    content: "",
    isDefault: false,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      timeframe: "5m",
      minLeverage: 1,
      maxLeverage: 3,
      symbols: ["BTC-USDT"],
      autoTradingEnabled: false,
      enableAiListener: true,
      enableTradingviewListener: false,
      tradingviewMode: "paper",
      tradingviewLeverage: 3,
      tradingviewOpenBalancePct: 100,
      tradingviewStopLossPct: 3,
      llmPromptTemplate: defaultTradingPrompt,
    },
  });

  const systemPrompts = promptTemplates.filter((item) => item.promptType === "system");
  const userPrompts = promptTemplates.filter((item) => item.promptType === "user");
  const selectedSymbols = useWatch({ control: form.control, name: "symbols" }) || [];
  const autoTradingEnabled = useWatch({ control: form.control, name: "autoTradingEnabled" });
  const enableAiListener = useWatch({ control: form.control, name: "enableAiListener" });
  const enableTradingviewListener = useWatch({ control: form.control, name: "enableTradingviewListener" });

  const loadPromptTemplates = async () => {
    setPromptLoading(true);
    try {
      const response = await fetch("/api/prompts", { cache: "no-store" });
      const result = await response.json();
      setPromptTemplates(Array.isArray(result?.data) ? result.data : []);
    } catch {
      setPromptTemplates([]);
    } finally {
      setPromptLoading(false);
    }
  };

  useEffect(() => {
    fetch("/api/trade/config", { cache: "no-store" })
      .then((res) => res.json())
      .then((result) => {
        const data = result?.data;
        if (!data) return;
        form.reset({
          timeframe: data.timeframe,
          minLeverage: data.minLeverage,
          maxLeverage: data.maxLeverage,
          symbols: data.symbols,
          autoTradingEnabled: data.autoTradingEnabled,
          enableAiListener: data.enableAiListener ?? true,
          enableTradingviewListener: data.enableTradingviewListener ?? false,
          tradingviewMode: data.tradingviewMode ?? "paper",
          tradingviewLeverage: data.tradingviewLeverage ?? 3,
          tradingviewOpenBalancePct: data.tradingviewOpenBalancePct ?? 100,
          tradingviewStopLossPct: data.tradingviewStopLossPct ?? 3,
          llmPromptTemplate: data.llmPromptTemplate,
        });
        setUserPrompt(data.llmPromptTemplate || defaultTradingPrompt);
      })
      .catch(() => {
        // ignore bootstrap errors
      });

    fetch("/api/config/system", { cache: "no-store" })
      .then((res) => res.json())
      .then((result) => {
        const data = result?.data;
        if (!data) return;

        setSystemConfig({
          llm: data.llm
            ? {
                provider: data.llm.provider,
                model: data.llm.model,
                apiKeyMasked: data.llm.apiKeyMasked || "",
                baseUrl: data.llm.baseUrl,
                temperature: data.llm.temperature,
                maxTokens: data.llm.maxTokens,
                decisionSchema: data.llm.decisionSchema || defaultDecisionSchema,
                secondaryConfirmation: data.llm.secondaryConfirmation,
                multiModelVoting: data.llm.multiModelVoting,
                structuredReasonOutput: data.llm.structuredReasonOutput,
              }
            : null,
          okx: data.okx
            ? {
                label: data.okx.label,
                envType: data.okx.envType,
                apiKeyMasked: data.okx.apiKeyMasked || "",
                hasSecret: Boolean(data.okx.hasSecret),
                hasPassphrase: Boolean(data.okx.hasPassphrase),
                readOnly: data.okx.readOnly,
                enableAutoTrading: data.okx.enableAutoTrading,
              }
            : null,
        });

        if (data.llm?.systemPrompt) {
          setSystemPrompt(data.llm.systemPrompt);
        }
        if (data.llm?.tradingPrompt) {
          setUserPrompt(data.llm.tradingPrompt);
          form.setValue("llmPromptTemplate", data.llm.tradingPrompt);
        }
      })
      .catch(() => {
        // ignore bootstrap errors
      });

    fetch("/api/trade/status", { cache: "no-store" })
      .then((res) => res.json())
      .then((result) => {
        const running = Boolean(result?.data?.running);
        setStatusText(running ? "任务运行中" : "任务未启动");
      })
      .catch(() => {
        setStatusText("任务状态未知");
      });

    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPromptTemplates();
  }, [form]);

  useEffect(() => {
    const systemHit = promptTemplates.find(
      (item) => item.promptType === "system" && item.content.trim() === (systemPrompt || "").trim(),
    );
    const userHit = promptTemplates.find(
      (item) => item.promptType === "user" && item.content.trim() === (userPrompt || "").trim(),
    );
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActivePromptIds({
      system: systemHit?.id || null,
      user: userHit?.id || null,
    });
  }, [promptTemplates, systemPrompt, userPrompt]);

  const openPromptEditor = (promptType: PromptType, template?: PromptTemplate) => {
    if (template) {
      setPromptEditor({
        open: true,
        id: template.id,
        promptType,
        name: template.name,
        content: template.content,
        isDefault: template.isDefault,
      });
      return;
    }

    setPromptEditor({
      open: true,
      id: null,
      promptType,
      name: "",
      content: promptType === "system" ? systemPrompt : userPrompt,
      isDefault: false,
    });
  };

  const persistAppliedPrompts = async (nextSystemPrompt: string, nextUserPrompt: string) => {
    const values = form.getValues();

    await fetch("/api/trade/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...values,
        llmPromptTemplate: nextUserPrompt,
      }),
    });

    const llmSnapshot = systemConfig.llm;
    const okxSnapshot = systemConfig.okx;

    const systemPayload = {
      llm: {
        provider: llmSnapshot?.provider || "openai",
        model: llmSnapshot?.model || "gpt-4o-mini",
        apiKey: llmSnapshot?.apiKeyMasked || "",
        baseUrl: llmSnapshot?.baseUrl || "https://api.openai.com/v1",
        temperature: llmSnapshot?.temperature ?? 0.2,
        maxTokens: llmSnapshot?.maxTokens ?? 800,
        systemPrompt: nextSystemPrompt,
        tradingPrompt: nextUserPrompt,
        decisionSchema: llmSnapshot?.decisionSchema || defaultDecisionSchema,
        secondaryConfirmation: llmSnapshot?.secondaryConfirmation ?? false,
        multiModelVoting: llmSnapshot?.multiModelVoting ?? false,
        structuredReasonOutput: llmSnapshot?.structuredReasonOutput ?? true,
      },
      okx: {
        label: okxSnapshot?.label || "OKX Demo",
        envType: okxSnapshot?.envType || "demo",
        apiKey: okxSnapshot?.apiKeyMasked || "",
        apiSecret: okxSnapshot?.hasSecret ? MASK_PLACEHOLDER : "",
        passphrase: okxSnapshot?.hasPassphrase ? MASK_PLACEHOLDER : "",
        readOnly: okxSnapshot?.readOnly ?? true,
        enableAutoTrading: okxSnapshot?.enableAutoTrading ?? false,
      },
    };

    await fetch("/api/config/system", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(systemPayload),
    });
  };

  const applyPromptTemplate = async (template: PromptTemplate) => {
    if (template.promptType === "system") {
      const nextSystemPrompt = template.content;
      const nextUserPrompt = userPrompt.trim() || form.getValues("llmPromptTemplate");
      setSystemPrompt(nextSystemPrompt);
      setActivePromptIds((prev) => ({ ...prev, system: template.id }));
      await persistAppliedPrompts(nextSystemPrompt, nextUserPrompt);
      return;
    }

    const nextSystemPrompt = systemPrompt.trim() || defaultSystemPrompt;
    const nextUserPrompt = template.content;
    setUserPrompt(nextUserPrompt);
    form.setValue("llmPromptTemplate", nextUserPrompt, { shouldValidate: true, shouldDirty: true });
    setActivePromptIds((prev) => ({ ...prev, user: template.id }));
    await persistAppliedPrompts(nextSystemPrompt, nextUserPrompt);
  };

  const removePromptTemplate = async (id: string) => {
    const response = await fetch(`/api/prompts?id=${id}`, { method: "DELETE" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      alert(`删除失败：${result?.message || result?.error || "未知错误"}`);
      return;
    }

    await loadPromptTemplates();
    setActivePromptIds((prev) => ({
      system: prev.system === id ? null : prev.system,
      user: prev.user === id ? null : prev.user,
    }));
  };

  const savePromptTemplate = async () => {
    if (!promptEditor.name.trim()) {
      alert("请填写提示词名称");
      return;
    }
    if (!promptEditor.content.trim()) {
      alert("提示词内容不能为空");
      return;
    }

    const currentCount =
      promptEditor.promptType === "system" ? systemPrompts.length : userPrompts.length;
    if (!promptEditor.id && currentCount >= MAX_PROMPTS_PER_TYPE) {
      alert(`每类提示词最多创建 ${MAX_PROMPTS_PER_TYPE} 个`);
      return;
    }

    const payload = {
      id: promptEditor.id,
      name: promptEditor.name.trim(),
      content: promptEditor.content,
      promptType: promptEditor.promptType,
      isDefault: promptEditor.isDefault,
    };

    const method = promptEditor.id ? "PUT" : "POST";
    const response = await fetch("/api/prompts", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      alert(`保存失败：${result?.message || result?.error || "未知错误"}`);
      return;
    }

    if (promptEditor.promptType === "system") {
      setSystemPrompt(promptEditor.content);
    } else {
      setUserPrompt(promptEditor.content);
      form.setValue("llmPromptTemplate", promptEditor.content, { shouldValidate: true, shouldDirty: true });
    }

    setPromptEditor((prev) => ({ ...prev, open: false }));
    await loadPromptTemplates();
  };

  const toggleSymbol = (symbol: string, checked: boolean) => {
    const current = form.getValues("symbols");
    if (checked) {
      if (!current.includes(symbol)) form.setValue("symbols", [...current, symbol], { shouldValidate: true });
      return;
    }
    const next = current.filter((item) => item !== symbol);
    form.setValue("symbols", next.length ? next : ["BTC-USDT"], { shouldValidate: true });
  };

  const saveTradeConfig = async (values: FormValues, effectiveUserPrompt = userPrompt.trim() || values.llmPromptTemplate) => {
    const response = await fetch("/api/trade/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...values,
        llmPromptTemplate: effectiveUserPrompt,
      }),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result?.message || result?.error || "未知错误");
    }
    return result;
  };

  const toggleAiChannel = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const values = {
        ...form.getValues(),
        autoTradingEnabled: enabled,
        enableAiListener: enabled,
      };
      form.setValue("autoTradingEnabled", enabled, { shouldDirty: true });
      form.setValue("enableAiListener", enabled, { shouldDirty: true });
      const result = await saveTradeConfig(values);
      setStatusText(enabled ? `AI 交易运行中（${result?.scheduler?.expression || "cron"}）` : "AI 交易已停止");
    } catch (error) {
      alert(`AI 交易开关保存失败：${error instanceof Error ? error.message : "未知错误"}`);
      form.setValue("autoTradingEnabled", !enabled);
      form.setValue("enableAiListener", !enabled);
    } finally {
      setBusy(false);
    }
  };

  const toggleTradingViewChannel = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const values = {
        ...form.getValues(),
        enableTradingviewListener: enabled,
      };
      form.setValue("enableTradingviewListener", enabled, { shouldDirty: true });
      await saveTradeConfig(values);
      setStatusText(enabled ? "TradingView webhook 监听已开启" : "TradingView webhook 监听已关闭");
    } catch (error) {
      alert(`TradingView 监听开关保存失败：${error instanceof Error ? error.message : "未知错误"}`);
      form.setValue("enableTradingviewListener", !enabled);
    } finally {
      setBusy(false);
    }
  };

  const onSave = form.handleSubmit(async (values) => {
    if (values.minLeverage > values.maxLeverage) {
      alert("最小杠杆不能大于最大杠杆");
      return;
    }

    const effectiveUserPrompt = userPrompt.trim() || values.llmPromptTemplate;

    let tradeResult: { scheduler?: { expression?: string } };
    try {
      tradeResult = await saveTradeConfig(values, effectiveUserPrompt);
    } catch (error) {
      alert(`保存失败：${error instanceof Error ? error.message : "未知错误"}`);
      return;
    }
    if (values.autoTradingEnabled) {
      setStatusText(`任务运行中（${tradeResult?.scheduler?.expression || "cron"}）`);
    } else {
      setStatusText("任务未启动");
    }

    const llmSnapshot = systemConfig.llm;
    const okxSnapshot = systemConfig.okx;

    const systemPayload = {
      llm: {
        provider: llmSnapshot?.provider || "openai",
        model: llmSnapshot?.model || "gpt-4o-mini",
        apiKey: llmSnapshot?.apiKeyMasked || "",
        baseUrl: llmSnapshot?.baseUrl || "https://api.openai.com/v1",
        temperature: llmSnapshot?.temperature ?? 0.2,
        maxTokens: llmSnapshot?.maxTokens ?? 800,
        systemPrompt: systemPrompt.trim() || defaultSystemPrompt,
        tradingPrompt: effectiveUserPrompt,
        decisionSchema: llmSnapshot?.decisionSchema || defaultDecisionSchema,
        secondaryConfirmation: llmSnapshot?.secondaryConfirmation ?? false,
        multiModelVoting: llmSnapshot?.multiModelVoting ?? false,
        structuredReasonOutput: llmSnapshot?.structuredReasonOutput ?? true,
      },
      okx: {
        label: okxSnapshot?.label || "OKX Demo",
        envType: okxSnapshot?.envType || "demo",
        apiKey: okxSnapshot?.apiKeyMasked || "",
        apiSecret: okxSnapshot?.hasSecret ? MASK_PLACEHOLDER : "",
        passphrase: okxSnapshot?.hasPassphrase ? MASK_PLACEHOLDER : "",
        readOnly: okxSnapshot?.readOnly ?? true,
        enableAutoTrading: okxSnapshot?.enableAutoTrading ?? false,
      },
    };

    const syncResponse = await fetch("/api/config/system", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(systemPayload),
    });

    if (!syncResponse.ok) {
      const syncResult = await syncResponse.json().catch(() => ({}));
      alert(`交易配置已保存，但系统提示词同步失败：${syncResult?.message || syncResult?.error || "未知错误"}`);
      return;
    }

    alert("交易配置已保存");
  });

  const startTask = async () => {
    setBusy(true);
    try {
      const values = form.getValues();
      if (values.minLeverage > values.maxLeverage) {
        alert("最小杠杆不能大于最大杠杆");
        return;
      }

      const effectiveUserPrompt = userPrompt.trim() || values.llmPromptTemplate;
      form.setValue("autoTradingEnabled", true);
      form.setValue("enableAiListener", true);

      const result = await saveTradeConfig({
        ...values,
        autoTradingEnabled: true,
        enableAiListener: true,
      }, effectiveUserPrompt).catch((error) => {
        alert(`启动失败：${error instanceof Error ? error.message : "未知错误"}`);
        return null;
      });
      if (!result) {
        return;
      }
      setStatusText(`AI 交易运行中（${result?.scheduler?.expression || "cron"}）`);
      alert("AI 自动交易已启动，已触发立即执行");
    } finally {
      setBusy(false);
    }
  };

  const stopTask = async () => {
    setBusy(true);
    try {
      const values = {
        ...form.getValues(),
        autoTradingEnabled: false,
        enableAiListener: false,
      };
      form.setValue("autoTradingEnabled", false);
      form.setValue("enableAiListener", false);
      await saveTradeConfig(values);
      setStatusText("AI 交易已停止");
      alert("AI 自动交易已停止");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>交易配置</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 md:grid-cols-2" onSubmit={onSave}>
          <div className="md:col-span-2 grid gap-3 lg:grid-cols-2">
            <div className="rounded-md border border-border bg-panel-soft p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-semibold text-primary-text">AI 自动交易通道</div>
                  <div className="mt-1 text-xs text-secondary-text">
                    开启后按下方 AI 策略配置定时拉取 OKX 数据并调用 LLM；关闭会同时停止 AI 监听和自动交易任务。
                  </div>
                </div>
                <Switch
                  checked={Boolean(autoTradingEnabled && enableAiListener)}
                  onCheckedChange={(value) => {
                    void toggleAiChannel(value);
                  }}
                />
              </div>
            </div>
            <div className="rounded-md border border-border bg-panel-soft p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-semibold text-primary-text">TradingView Webhook 通道</div>
                  <div className="mt-1 text-xs text-secondary-text">
                    开启后只接收 TradingView 警报信号并按 webhook 规则执行；不调用 LLM，也不依赖 AI 定时任务。
                  </div>
                </div>
                <Switch
                  checked={Boolean(enableTradingviewListener)}
                  onCheckedChange={(value) => {
                    void toggleTradingViewChannel(value);
                  }}
                />
              </div>
            </div>
          </div>

          <div className="md:col-span-2 rounded-md border border-border bg-panel-soft p-4">
            <div className="mb-4">
              <div className="text-sm font-semibold text-primary-text">TradingView 交易配置</div>
              <div className="mt-1 text-xs text-secondary-text">
                仅影响 TradingView webhook 信号：开仓/加仓会按可用 USDT 的指定比例计算合约张数，并自动附带止损。
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-4">
              <div className="space-y-2">
                <label className="text-sm text-primary-text">TV 执行模式</label>
                <Select {...form.register("tradingviewMode")}>
                  <option value="paper">paper 模拟记录</option>
                  <option value="live">OKX 下单</option>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm text-primary-text">TV 杠杆倍数</label>
                <Input type="number" min={1} max={15} step="1" {...form.register("tradingviewLeverage", { valueAsNumber: true })} />
              </div>
              <div className="space-y-2">
                <label className="text-sm text-primary-text">开仓余额比例 (%)</label>
                <Input type="number" min={1} max={100} step="1" {...form.register("tradingviewOpenBalancePct", { valueAsNumber: true })} />
              </div>
              <div className="space-y-2">
                <label className="text-sm text-primary-text">自动止损 (%)</label>
                <Input type="number" min={0.1} max={30} step="0.1" {...form.register("tradingviewStopLossPct", { valueAsNumber: true })} />
              </div>
            </div>
          </div>

          <div className="md:col-span-2 rounded-md border border-border bg-panel-soft p-4">
            <div className="text-sm font-semibold text-primary-text">AI 交易配置</div>
            <div className="mt-1 text-xs text-secondary-text">以下参数只影响 AI 自动交易通道，不影响 TradingView webhook 的开关状态。</div>
          </div>

          <div className="space-y-2">
            <label className="text-sm text-primary-text">K线监听周期</label>
            <Select {...form.register("timeframe")}>
              {["15s", "1m", "3m", "5m", "15m", "1h"].map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm text-primary-text">最小杠杆</label>
            <Input type="number" step="0.1" {...form.register("minLeverage", { valueAsNumber: true })} />
          </div>

          <div className="space-y-2">
            <label className="text-sm text-primary-text">最大杠杆</label>
            <Input type="number" step="0.1" {...form.register("maxLeverage", { valueAsNumber: true })} />
          </div>

          <div className="md:col-span-2 space-y-2">
            <label className="text-sm text-primary-text">交易币种（多选）</label>
            <p className="text-xs text-secondary-text">
              选中的币种会在下一轮 OKX 数据抓取和 LLM prompt 中自动扩展同一套 3m/4H/funding/OI 指标。
            </p>
            <div className="grid max-h-80 gap-2 overflow-y-auto rounded-md border border-border p-2 sm:grid-cols-2 md:grid-cols-4 xl:grid-cols-6">
              {symbolOptions.map((symbol) => {
                const selected = selectedSymbols.includes(symbol);
                return (
                  <label
                    key={symbol}
                    className="rounded-md border border-border bg-panel-soft px-3 py-2 text-sm text-primary-text flex items-center gap-2"
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(e) => toggleSymbol(symbol, e.target.checked)}
                    />
                    {symbol}
                  </label>
                );
              })}
            </div>
          </div>

          <div className="md:col-span-2 space-y-3">
            <label className="text-sm text-primary-text">提示词模板库</label>
            <div className="rounded-lg border border-border bg-panel p-4 space-y-4">
              <p className="text-sm text-secondary-text">系统提示词与用户提示词统一在此管理。应用后会写入当前交易配置与系统配置。</p>

              <div className="rounded-lg border border-border bg-panel p-4 space-y-3">
                <p className="text-sm font-semibold text-primary-text">系统提示词</p>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
                  {systemPrompts.map((item, index) => {
                    const isActive = activePromptIds.system === item.id;
                    return (
                      <div
                        key={item.id}
                        onClick={() => openPromptEditor("system", item)}
                        className={`min-h-28 rounded-md border p-3 flex flex-col cursor-pointer transition-colors ${
                          isActive
                            ? "border-emerald-400 bg-emerald-500/10"
                            : "border-border bg-panel-soft hover:border-emerald-400/60"
                        }`}
                      >
                        <button
                          type="button"
                          className="mb-2 line-clamp-2 text-left text-sm font-medium text-primary-text hover:text-brand"
                          onClick={() => openPromptEditor("system", item)}
                        >
                          {`策略 ${index + 1}：${item.name}`}
                        </button>
                        <div className="mt-auto pt-3 flex gap-2">
                          <Button
                            className="px-2 py-1 text-xs"
                            type="button"
                            variant="outline"
                            onClick={(e) => {
                              e.stopPropagation();
                              void applyPromptTemplate(item);
                            }}
                          >
                            应用
                          </Button>
                          <Button
                            className="px-2 py-1 text-xs"
                            type="button"
                            variant="danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              void removePromptTemplate(item.id);
                            }}
                          >
                            删除
                          </Button>
                        </div>
                        {isActive ? <p className="mt-2 text-xs text-emerald-300">正在使用</p> : null}
                      </div>
                    );
                  })}

                  <button
                    type="button"
                    disabled={systemPrompts.length >= MAX_PROMPTS_PER_TYPE}
                    className="min-h-28 rounded-xl border-2 border-dashed border-border bg-panel-soft px-4 py-5 text-left text-base text-secondary-text hover:border-emerald-400/70 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => openPromptEditor("system")}
                  >
                    {systemPrompts.length >= MAX_PROMPTS_PER_TYPE
                      ? `已达上限（${MAX_PROMPTS_PER_TYPE}）`
                      : "+ 添加提示词"}
                  </button>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-panel p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-primary-text">用户提示词</p>
                  <div className="relative group">
                    <span className="inline-flex h-5 w-5 cursor-help items-center justify-center rounded-full border border-border text-xs text-secondary-text">?</span>
                    <div className="pointer-events-none absolute left-6 top-0 z-20 hidden w-72 rounded-md border border-border bg-panel p-3 text-xs text-secondary-text shadow-xl group-hover:block">
                      可在提示词中使用以下标准变量名：
                      <div className="mt-2 space-y-1 text-primary-text">
                        <div>{"{{symbol}}"}: 交易对，例如 BTC-USDT-SWAP</div>
                        <div>{"{{coin}}"}: 当前币种，例如 BTC</div>
                        <div>{"{{exchange}}"}: 交易所名称</div>
                        <div>{"{{contract}}"}: 合约类型（perpetual）</div>
                        <div>{"{{asset_universe}}"}: 可交易币种列表</div>
                        <div>{"{{selected_symbols}}"}: 当前选中的交易币种</div>
                        <div>{"{{decision_frequency}}"}: 决策频率/策略周期</div>
                        <div>{"{{timestamp}}"}: 当前时间（ISO）</div>
                        <div>{"{{timeframe}}"}: 当前策略周期（如 15s/1m/5m）</div>
                        <div>{"{{market_data}}"}: OKX K线数据</div>
                        <div>{"{{market_data_raw}}"}: 原始K线数组</div>
                        <div>{"{{market_data_4h}}"}: 4小时级别K线数据</div>
                        <div>{"{{current_price}}"}: 最新价格</div>
                        <div>{"{{indicators}}"}: 技术指标聚合（EMA/MACD/RSI/ATR）</div>
                        <div>{"{{indicators_4h}}"}: 4小时技术指标聚合</div>
                        <div>{"{{ema_20}}"}: EMA(20)</div>
                        <div>{"{{ema_50}}"}: EMA(50)</div>
                        <div>{"{{macd}}"}: MACD结构（line/signal/histogram）</div>
                        <div>{"{{rsi_14}}"}: RSI(14)</div>
                        <div>{"{{atr_14}}"}: ATR(14)</div>
                        <div>{"{{sharpe_ratio}}"}: 近30条PnL估算夏普比率</div>
                        <div>{"{{balance}}"}: 账户余额</div>
                        <div>{"{{positions}}"}: 当前持仓</div>
                        <div>{"{{open_positions}}"}: 当前持仓（positions别名）</div>
                        <div>{"{{funding_rate}}"}: 资金费率</div>
                        <div>{"{{funding}}"}: 资金费率（funding_rate别名）</div>
                        <div>{"{{open_interest}}"}: 持仓量（Open Interest）</div>
                        <div>{"{{open_orders}}"}: 当前挂单</div>
                        <div>{"{{pending_orders}}"}: 当前挂单（open_orders别名）</div>
                        <div>{"{{account_state}}"}: 账户综合快照（余额/持仓/挂单/价格）</div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
                  {userPrompts.map((item, index) => {
                    const isActive = activePromptIds.user === item.id;
                    return (
                      <div
                        key={item.id}
                        onClick={() => openPromptEditor("user", item)}
                        className={`min-h-28 rounded-md border p-3 flex flex-col cursor-pointer transition-colors ${
                          isActive
                            ? "border-emerald-400 bg-emerald-500/10"
                            : "border-border bg-panel-soft hover:border-emerald-400/60"
                        }`}
                      >
                        <button
                          type="button"
                          className="mb-2 line-clamp-2 text-left text-sm font-medium text-primary-text hover:text-brand"
                          onClick={() => openPromptEditor("user", item)}
                        >
                          {`策略 ${index + 1}：${item.name}`}
                        </button>
                        <div className="mt-auto pt-3 flex gap-2">
                          <Button
                            className="px-2 py-1 text-xs"
                            type="button"
                            variant="outline"
                            onClick={(e) => {
                              e.stopPropagation();
                              void applyPromptTemplate(item);
                            }}
                          >
                            应用
                          </Button>
                          <Button
                            className="px-2 py-1 text-xs"
                            type="button"
                            variant="danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              void removePromptTemplate(item.id);
                            }}
                          >
                            删除
                          </Button>
                        </div>
                        {isActive ? <p className="mt-2 text-xs text-emerald-300">正在使用</p> : null}
                      </div>
                    );
                  })}

                  <button
                    type="button"
                    disabled={userPrompts.length >= MAX_PROMPTS_PER_TYPE}
                    className="min-h-28 rounded-xl border-2 border-dashed border-border bg-panel-soft px-4 py-5 text-left text-base text-secondary-text hover:border-emerald-400/70 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => openPromptEditor("user")}
                  >
                    {userPrompts.length >= MAX_PROMPTS_PER_TYPE
                      ? `已达上限（${MAX_PROMPTS_PER_TYPE}）`
                      : "+ 添加提示词"}
                  </button>
                </div>
              </div>

              {promptLoading ? <p className="text-sm text-secondary-text">模板加载中...</p> : null}
            </div>
          </div>

          <div className="md:col-span-2 rounded-md border border-border p-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="text-sm text-secondary-text">当前任务状态：{statusText}</div>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={startTask} disabled={busy}>启动 AI 交易</Button>
              <Button type="button" variant="danger" onClick={stopTask} disabled={busy}>停止 AI 交易</Button>
              <Button type="submit" disabled={busy}>保存配置</Button>
            </div>
          </div>
        </form>
      </CardContent>

      {promptEditor.open ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-4xl rounded-xl border border-border bg-panel shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <p className="text-sm font-semibold text-primary-text">
                {promptEditor.id ? "编辑" : "新建"}
                {promptEditor.promptType === "system" ? "系统提示词" : "用户提示词"}
              </p>
              <Button type="button" variant="secondary" onClick={() => setPromptEditor((prev) => ({ ...prev, open: false }))}>
                关闭
              </Button>
            </div>

            <div className="space-y-4 p-4">
              <div className="space-y-2">
                <label className="text-sm text-primary-text">提示词名称</label>
                <Input
                  value={promptEditor.name}
                  onChange={(e) => setPromptEditor((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder={promptEditor.promptType === "system" ? "例如：机构风控版系统提示词" : "例如：短线动量用户提示词"}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm text-primary-text">提示词内容</label>
                <Textarea
                  rows={22}
                  className="bg-[repeating-linear-gradient(to_bottom,rgba(255,255,255,0.02),rgba(255,255,255,0.02)_31px,rgba(148,163,184,0.2)_32px)] font-mono"
                  value={promptEditor.content}
                  onChange={(e) => setPromptEditor((prev) => ({ ...prev, content: e.target.value }))}
                />
              </div>

              <div className="rounded-md border border-border p-3 flex items-center justify-between">
                <span className="text-sm text-primary-text">设为默认模板</span>
                <Switch
                  checked={promptEditor.isDefault}
                  onCheckedChange={(value) => setPromptEditor((prev) => ({ ...prev, isDefault: value }))}
                />
              </div>

              <div className="flex gap-2">
                <Button type="button" onClick={savePromptTemplate}>保存模板</Button>
                {promptEditor.id ? (
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() => {
                      void removePromptTemplate(promptEditor.id!);
                    }}
                  >
                    删除模板
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
