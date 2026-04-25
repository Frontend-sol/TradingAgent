"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

const schema = z.object({
  maxPositionValue: z.number().min(0),
  maxSingleOrderValue: z.number().min(0),
  maxDailyLoss: z.number().min(0),
  maxDrawdownPct: z.number().min(0).max(100),
  maxConsecutiveLosses: z.number().int().min(1).max(100),
  stopOnModelError: z.boolean(),
  stopOnApiError: z.boolean(),
  highVolatilityPause: z.boolean(),
  volatilityThreshold: z.number().min(0),
  whitelistSymbols: z.string(),
  blacklistSymbols: z.string(),
  killSwitchEnabled: z.boolean(),
});

type FormValues = z.infer<typeof schema>;

export default function RiskCenterPage() {
  const [loading, setLoading] = useState(true);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      maxPositionValue: 20000,
      maxSingleOrderValue: 5000,
      maxDailyLoss: 1000,
      maxDrawdownPct: 12,
      maxConsecutiveLosses: 3,
      stopOnModelError: true,
      stopOnApiError: true,
      highVolatilityPause: true,
      volatilityThreshold: 4,
      whitelistSymbols: "BTC-USDT-SWAP,ETH-USDT-SWAP",
      blacklistSymbols: "",
      killSwitchEnabled: false,
    },
  });

  useEffect(() => {
    fetch("/api/config/risk", { cache: "no-store" })
      .then((res) => res.json())
      .then((result) => {
        const risk = result?.data;
        if (!risk) return;

        form.reset({
          maxPositionValue: risk.maxPositionValue,
          maxSingleOrderValue: risk.maxSingleOrderValue,
          maxDailyLoss: risk.maxDailyLoss,
          maxDrawdownPct: risk.maxDrawdownPct,
          maxConsecutiveLosses: risk.maxConsecutiveLosses,
          stopOnModelError: risk.stopOnModelError,
          stopOnApiError: risk.stopOnApiError,
          highVolatilityPause: risk.highVolatilityPause,
          volatilityThreshold: risk.volatilityThreshold,
          whitelistSymbols: (risk.whitelistSymbols || []).join(","),
          blacklistSymbols: (risk.blacklistSymbols || []).join(","),
          killSwitchEnabled: risk.killSwitchEnabled,
        });
      })
      .finally(() => setLoading(false));
  }, [form]);

  const onSubmit = form.handleSubmit(async (values) => {
    const payload = {
      ...values,
      whitelistSymbols: values.whitelistSymbols
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      blacklistSymbols: values.blacklistSymbols
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    };

    const response = await fetch("/api/config/risk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      alert(`保存失败：${result?.message || result?.error || "风控配置保存失败"}`);
      return;
    }

    alert("风控配置已保存");
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>风控中心</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 md:grid-cols-2" onSubmit={onSubmit}>
            {[
              ["maxPositionValue", "最大仓位限制(USDT)"],
              ["maxSingleOrderValue", "最大单笔下单金额(USDT)"],
              ["maxDailyLoss", "最大日亏损阈值(USDT)"],
              ["maxDrawdownPct", "最大回撤阈值(%)"],
              ["maxConsecutiveLosses", "连续亏损停止阈值(次)"],
              ["volatilityThreshold", "波动率暂停阈值(%)"],
            ].map(([key, label]) => (
              <div key={key} className="space-y-2">
                <label className="text-sm text-primary-text">{label}</label>
                <Input type="number" step="0.1" {...form.register(key as keyof FormValues, { valueAsNumber: true })} />
              </div>
            ))}

            <div className="md:col-span-2 space-y-2">
              <label className="text-sm text-primary-text">白名单标的（逗号分隔）</label>
              <Input {...form.register("whitelistSymbols")} />
            </div>

            <div className="md:col-span-2 space-y-2">
              <label className="text-sm text-primary-text">黑名单标的（逗号分隔）</label>
              <Input {...form.register("blacklistSymbols")} />
            </div>

            <div className="rounded-md border border-border p-3 flex items-center justify-between">
              <span className="text-sm text-primary-text">模型异常停止交易</span>
              <Switch
                checked={form.watch("stopOnModelError")}
                onCheckedChange={(value) => form.setValue("stopOnModelError", value)}
              />
            </div>

            <div className="rounded-md border border-border p-3 flex items-center justify-between">
              <span className="text-sm text-primary-text">网络/API 异常停止交易</span>
              <Switch
                checked={form.watch("stopOnApiError")}
                onCheckedChange={(value) => form.setValue("stopOnApiError", value)}
              />
            </div>

            <div className="rounded-md border border-border p-3 flex items-center justify-between">
              <span className="text-sm text-primary-text">波动率过高暂停交易</span>
              <Switch
                checked={form.watch("highVolatilityPause")}
                onCheckedChange={(value) => form.setValue("highVolatilityPause", value)}
              />
            </div>

            <div className="rounded-md border border-border p-3 flex items-center justify-between">
              <span className="text-sm text-primary-text">Kill Switch（一键急停）</span>
              <Switch
                checked={form.watch("killSwitchEnabled")}
                onCheckedChange={(value) => form.setValue("killSwitchEnabled", value)}
              />
            </div>

            <div className="md:col-span-2 flex gap-2">
              <Button type="submit" disabled={loading}>保存风控配置</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
