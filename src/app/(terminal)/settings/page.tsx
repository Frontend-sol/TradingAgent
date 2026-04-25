"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { SuccessDialog } from "@/components/ui/success-dialog";

const llmSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  apiKey: z.string(),
  baseUrl: z.string().url(),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().min(32).max(4000),
  systemPrompt: z.string().min(1),
  tradingPrompt: z.string().min(1),
  decisionSchema: z.string().min(1),
  secondaryConfirmation: z.boolean(),
  multiModelVoting: z.boolean(),
  structuredReasonOutput: z.boolean(),
});

const okxSchema = z.object({
  label: z.string().min(1),
  envType: z.enum(["demo", "live"]),
  apiKey: z.string(),
  apiSecret: z.string(),
  passphrase: z.string(),
  readOnly: z.boolean(),
  enableAutoTrading: z.boolean(),
});

type LlmFormValues = z.infer<typeof llmSchema>;
type OkxFormValues = z.infer<typeof okxSchema>;
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

const MAX_PROMPTS_PER_TYPE = 4;

const defaultPrompt = `你是一名严格的加密资产量化交易分析师。
你的任务不是预测市场，而是在给定市场数据、账户状态、当前仓位、最近交易记录和风险约束的前提下，输出一个审慎、可执行、可审计的交易决策。
请严格只返回 JSON，不要输出任何额外解释。`;

const MASK_PLACEHOLDER = "********";

function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-secondary-text">{children}</p>;
}

export default function SettingsPage() {
  const router = useRouter();
  const [dialog, setDialog] = useState<{ open: boolean; text: string }>({ open: false, text: "" });
  const [testingOkx, setTestingOkx] = useState(false);
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplate[]>([]);
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptEditor, setPromptEditor] = useState<PromptEditorState>({
    open: false,
    id: null,
    promptType: "system",
    name: "",
    content: "",
    isDefault: false,
  });
  const [activePromptIds, setActivePromptIds] = useState<{ system: string | null; user: string | null }>({
    system: null,
    user: null,
  });

  const llmForm = useForm<LlmFormValues>({
    resolver: zodResolver(llmSchema),
    defaultValues: {
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      temperature: 0.2,
      maxTokens: 800,
      systemPrompt: "You are a strict crypto quantitative analyst.",
      tradingPrompt: defaultPrompt,
      decisionSchema: JSON.stringify(
        {
          action: "buy | sell | hold | close_long | close_short | open_long | open_short",
          confidence: "0-100",
          reason_summary: "一句话摘要",
        },
        null,
        2,
      ),
      secondaryConfirmation: false,
      multiModelVoting: false,
      structuredReasonOutput: true,
    },
  });

  const okxForm = useForm<OkxFormValues>({
    resolver: zodResolver(okxSchema),
    defaultValues: {
      label: "OKX Demo",
      envType: "demo",
      apiKey: "",
      apiSecret: "",
      passphrase: "",
      readOnly: true,
      enableAutoTrading: false,
    },
  });

  useEffect(() => {
    fetch("/api/config/system", { cache: "no-store" })
      .then((res) => res.json())
      .then((result) => {
        const data = result?.data;
        if (!data) return;

        if (data.llm) {
          llmForm.reset({
            provider: data.llm.provider,
            model: data.llm.model,
            apiKey: data.llm.apiKeyMasked || "",
            baseUrl: data.llm.baseUrl,
            temperature: data.llm.temperature,
            maxTokens: data.llm.maxTokens,
            systemPrompt: data.llm.systemPrompt,
            tradingPrompt: data.llm.tradingPrompt,
            decisionSchema: JSON.stringify(data.llm.decisionSchema, null, 2),
            secondaryConfirmation: data.llm.secondaryConfirmation,
            multiModelVoting: data.llm.multiModelVoting,
            structuredReasonOutput: data.llm.structuredReasonOutput,
          });
        }

        if (data.okx) {
          okxForm.reset({
            label: data.okx.label,
            envType: data.okx.envType,
            apiKey: data.okx.hasApiKey ? data.okx.apiKeyMasked || MASK_PLACEHOLDER : "",
            apiSecret: data.okx.hasSecret ? MASK_PLACEHOLDER : "",
            passphrase: data.okx.hasPassphrase ? MASK_PLACEHOLDER : "",
            readOnly: data.okx.readOnly,
            enableAutoTrading: data.okx.enableAutoTrading,
          });
        }
      });
  }, [llmForm, okxForm]);

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
    void loadPromptTemplates();
  }, []);

  const currentSystemPrompt = llmForm.watch("systemPrompt");
  const currentUserPrompt = llmForm.watch("tradingPrompt");

  useEffect(() => {
    const systemHit = promptTemplates.find(
      (item) => item.promptType === "system" && item.content.trim() === (currentSystemPrompt || "").trim(),
    );
    const userHit = promptTemplates.find(
      (item) => item.promptType === "user" && item.content.trim() === (currentUserPrompt || "").trim(),
    );

    setActivePromptIds({
      system: systemHit?.id || null,
      user: userHit?.id || null,
    });
  }, [promptTemplates, currentSystemPrompt, currentUserPrompt]);

  const openPromptEditor = (promptType: PromptType, template?: PromptTemplate) => {
    if (template) {
      setPromptEditor({
        open: true,
        id: template.id,
        promptType: template.promptType,
        name: template.name,
        content: template.content,
        isDefault: template.isDefault,
      });
      return;
    }

    const fallbackContent = promptType === "system" ? llmForm.getValues("systemPrompt") : llmForm.getValues("tradingPrompt");
    setPromptEditor({
      open: true,
      id: null,
      promptType,
      name: "",
      content: fallbackContent,
      isDefault: false,
    });
  };

  const removePromptTemplate = async (id: string) => {
    try {
      const response = await fetch(`/api/prompts?id=${id}`, { method: "DELETE" });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result?.message || result?.error || "删除失败");
      }

      await loadPromptTemplates();
      setDialog({ open: true, text: "提示词已删除" });
      if (promptEditor.id === id) {
        setPromptEditor((prev) => ({ ...prev, open: false, id: null }));
      }
    } catch (error) {
      setDialog({
        open: true,
        text: error instanceof Error ? `删除失败：${error.message}` : "删除失败",
      });
    }
  };

  const savePromptTemplate = async () => {
    try {
      const isCreate = !promptEditor.id;
      if (!promptEditor.name.trim()) {
        throw new Error("请填写提示词名称");
      }
      if (!promptEditor.content.trim()) {
        throw new Error("提示词内容不能为空");
      }

      const currentCount =
        promptEditor.promptType === "system" ? systemPrompts.length : userPrompts.length;
      if (!promptEditor.id && currentCount >= MAX_PROMPTS_PER_TYPE) {
        throw new Error(`每类提示词最多创建 ${MAX_PROMPTS_PER_TYPE} 个`);
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
        throw new Error(result?.message || result?.error || "提示词保存失败");
      }

      if (promptEditor.promptType === "system") {
        llmForm.setValue("systemPrompt", promptEditor.content);
      } else {
        llmForm.setValue("tradingPrompt", promptEditor.content);
      }

      await loadPromptTemplates();
      setPromptEditor((prev) => ({ ...prev, open: false }));
      setDialog({ open: true, text: isCreate ? "提示词创建成功" : "提示词保存成功" });
    } catch (error) {
      setDialog({
        open: true,
        text: error instanceof Error ? `保存失败：${error.message}` : "保存失败",
      });
    }
  };

  const applyPromptTemplate = (template: PromptTemplate) => {
    if (template.promptType === "system") {
      llmForm.setValue("systemPrompt", template.content);
      setActivePromptIds((prev) => ({ ...prev, system: template.id }));
    } else {
      llmForm.setValue("tradingPrompt", template.content);
      setActivePromptIds((prev) => ({ ...prev, user: template.id }));
    }
    setDialog({ open: true, text: `已应用${template.promptType === "system" ? "系统" : "用户"}提示词：${template.name}` });
  };

  const systemPrompts = promptTemplates.filter((item) => item.promptType === "system");
  const userPrompts = promptTemplates.filter((item) => item.promptType === "user");

  const persistSystemConfig = async (successText: string) => {
    try {
      const llmValues = llmForm.getValues();
      const okxValues = okxForm.getValues();
      const payload = {
        llm: {
          ...llmValues,
          decisionSchema: JSON.parse(llmValues.decisionSchema),
        },
        okx: okxValues,
      };

      const response = await fetch("/api/config/system", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const backendMessage = result?.message || result?.error || "配置保存失败";
        throw new Error(`[${response.status}] ${backendMessage}`);
      }

      setDialog({ open: true, text: successText });
      router.refresh();
    } catch (error) {
      setDialog({
        open: true,
        text: error instanceof Error ? `保存失败：${error.message}` : "保存失败，请检查配置。",
      });
    }
  };

  const saveLlm = llmForm.handleSubmit(async () => {
    await persistSystemConfig("LLM 配置已成功更新");
  });

  const saveOkx = okxForm.handleSubmit(async () => {
    await persistSystemConfig("OKX 配置已成功更新");
  });

  const testOkxConnection = async () => {
    const values = okxForm.getValues();
    setTestingOkx(true);
    try {
      const response = await fetch("/api/config/system/test-okx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          envType: values.envType,
          apiKey: values.apiKey,
          apiSecret: values.apiSecret,
          passphrase: values.passphrase,
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        setDialog({
          open: true,
          text: result?.message || "连接测试失败",
        });
        return;
      }

      await persistSystemConfig("连接测试成功，配置已自动保存并同步。");
    } catch (error) {
      setDialog({
        open: true,
        text: error instanceof Error ? `连接测试失败：${error.message}` : "连接测试失败",
      });
    } finally {
      setTestingOkx(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>LLM 配置区</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 md:grid-cols-2" onSubmit={saveLlm}>
            <div className="space-y-2">
              <label className="text-sm text-primary-text">模型提供商</label>
              <FieldHint>选择调用的模型服务商，支持 OpenAI/Anthropic/Gemini/OpenRouter/自定义兼容接口。</FieldHint>
              <Select {...llmForm.register("provider")}>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="gemini">Gemini</option>
                <option value="openrouter">OpenRouter</option>
                <option value="custom">自定义 OpenAI 兼容</option>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm text-primary-text">模型名称</label>
              <FieldHint>例如 gpt-4o-mini、claude-3-7-sonnet，用于指定具体模型。</FieldHint>
              <Input {...llmForm.register("model")} />
            </div>

            <div className="space-y-2">
              <label className="text-sm text-primary-text">API Key</label>
              <FieldHint>模型服务密钥，留空表示不覆盖现有密钥。</FieldHint>
              <Input type="password" placeholder="sk-..." {...llmForm.register("apiKey")} />
            </div>

            <div className="space-y-2">
              <label className="text-sm text-primary-text">Base URL</label>
              <FieldHint>模型接口根地址，自定义网关时需要修改。</FieldHint>
              <Input {...llmForm.register("baseUrl")} />
            </div>

            <div className="space-y-2">
              <label className="text-sm text-primary-text">temperature</label>
              <FieldHint>控制输出随机性，建议 0~0.3 保持策略稳定。</FieldHint>
              <Input type="number" step="0.1" {...llmForm.register("temperature", { valueAsNumber: true })} />
            </div>

            <div className="space-y-2">
              <label className="text-sm text-primary-text">max tokens</label>
              <FieldHint>单次响应最大长度，过大会增加成本与延迟。</FieldHint>
              <Input type="number" {...llmForm.register("maxTokens", { valueAsNumber: true })} />
            </div>

            <div className="md:col-span-2 rounded-md border border-border p-3">
              <p className="text-sm text-primary-text">提示词模板库与 decision schema 已迁移至交易配置页维护。</p>
              <p className="text-xs text-secondary-text mt-1">请前往“交易配置”页面管理系统提示词、用户提示词与策略模板应用。</p>
            </div>

            <div className="rounded-md border border-border p-3 flex items-center justify-between">
              <div>
                <p className="text-sm text-primary-text">启用二次确认</p>
                <FieldHint>高风险指令可要求第二次校验再执行。</FieldHint>
              </div>
              <Switch checked={llmForm.watch("secondaryConfirmation")} onCheckedChange={(value) => llmForm.setValue("secondaryConfirmation", value)} />
            </div>

            <div className="rounded-md border border-border p-3 flex items-center justify-between">
              <div>
                <p className="text-sm text-primary-text">启用多模型投票</p>
                <FieldHint>多模型并行输出后再聚合，降低单模型偏差。</FieldHint>
              </div>
              <Switch checked={llmForm.watch("multiModelVoting")} onCheckedChange={(value) => llmForm.setValue("multiModelVoting", value)} />
            </div>

            <div className="rounded-md border border-border p-3 flex items-center justify-between">
              <div>
                <p className="text-sm text-primary-text">启用结构化理由输出</p>
                <FieldHint>写入趋势、动量、波动率等标签，便于复盘。</FieldHint>
              </div>
              <Switch checked={llmForm.watch("structuredReasonOutput")} onCheckedChange={(value) => llmForm.setValue("structuredReasonOutput", value)} />
            </div>

            <div className="md:col-span-2">
              <Button type="submit">保存 LLM 配置</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>OKX 配置区</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 md:grid-cols-2" onSubmit={saveOkx}>
            <div className="space-y-2">
              <label className="text-sm text-primary-text">账户标签</label>
              <FieldHint>用于区分不同账户，如“OKX Demo”或“主交易账户”。</FieldHint>
              <Input {...okxForm.register("label")} />
            </div>

            <div className="space-y-2">
              <label className="text-sm text-primary-text">交易环境</label>
              <FieldHint>默认建议 Demo，确认流程稳定后再切换 Live。</FieldHint>
              <Select {...okxForm.register("envType")}>
                <option value="demo">Demo / Simulated</option>
                <option value="live">Live / Real</option>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm text-primary-text">API Key</label>
              <FieldHint>OKX 公钥，留空表示不覆盖现有值。</FieldHint>
              <Input type="password" {...okxForm.register("apiKey")} />
            </div>

            <div className="space-y-2">
              <label className="text-sm text-primary-text">API Secret</label>
              <FieldHint>OKX 私钥，仅后端加密保存，前端不会回显。</FieldHint>
              <Input type="password" {...okxForm.register("apiSecret")} />
            </div>

            <div className="space-y-2 md:col-span-2">
              <label className="text-sm text-primary-text">Passphrase</label>
              <FieldHint>OKX API 口令，仅后端加密保存。</FieldHint>
              <Input type="password" {...okxForm.register("passphrase")} />
            </div>

            <div className="rounded-md border border-border p-3 flex items-center justify-between">
              <div>
                <p className="text-sm text-primary-text">只读模式</p>
                <FieldHint>启用后仅拉取数据，不允许实际下单。</FieldHint>
              </div>
              <Switch checked={okxForm.watch("readOnly")} onCheckedChange={(value) => okxForm.setValue("readOnly", value)} />
            </div>

            <div className="rounded-md border border-border p-3 flex items-center justify-between">
              <div>
                <p className="text-sm text-primary-text">自动交易</p>
                <FieldHint>开启后允许策略自动执行订单，建议先在 Demo 验证。</FieldHint>
              </div>
              <Switch checked={okxForm.watch("enableAutoTrading")} onCheckedChange={(value) => okxForm.setValue("enableAutoTrading", value)} />
            </div>

            <div className="md:col-span-2 flex gap-3">
              <Button type="button" variant="secondary" onClick={testOkxConnection} disabled={testingOkx}>
                {testingOkx ? "测试中..." : "测试 OKX 连接"}
              </Button>
              <Button type="submit">保存 OKX 配置</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <SuccessDialog
        open={dialog.open}
        description={dialog.text}
        onClose={() => setDialog({ open: false, text: "" })}
      />

      {promptEditor.open ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-4xl rounded-xl border border-border bg-panel shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <p className="text-sm font-semibold text-primary-text">
                {promptEditor.id ? "编辑" : "新建"}
                {promptEditor.promptType === "system" ? "系统提示词" : "用户提示词"}
              </p>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setPromptEditor((prev) => ({ ...prev, open: false }))}
              >
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
    </div>
  );
}
