import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { encryptText } from "@/lib/crypto";
import { DEMO_USER_EMAIL, maskSecret } from "@/lib/utils";
import { z } from "zod";
import { syncDefaultUserConfig } from "@/lib/config/default-user-config";

const llmSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  apiKey: z.string().min(1),
  baseUrl: z.string().url(),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().min(32).max(4000),
  systemPrompt: z.string().min(1),
  tradingPrompt: z.string().min(1),
  decisionSchema: z.record(z.string(), z.unknown()),
  secondaryConfirmation: z.boolean(),
  multiModelVoting: z.boolean(),
  structuredReasonOutput: z.boolean(),
});

function buildEnvLlmDefaults() {
  return {
    provider: process.env.LLM_DEFAULT_PROVIDER || "deepseek",
    model: process.env.LLM_DEFAULT_MODEL || "deepseek-reasoner",
    apiKey: process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || "",
    baseUrl: process.env.LLM_BASE_URL || "https://api.deepseek.com",
    temperature: 0.2,
    maxTokens: 1200,
    systemPrompt: "You are a strict crypto quantitative analyst. Return one valid JSON object only.",
    tradingPrompt: "请基于以下信息输出交易决策JSON：\n标的：{{symbol}}\n时间：{{timestamp}}\n账户：{{balance}}\n行情：{{market_data}}",
    decisionSchema: {
      signal: "buy_to_enter | sell_to_enter | hold | close",
      coin: "BTC | ETH | SOL | BNB | DOGE | XRP",
      quantity: "number",
      leverage: "number",
      confidence: "0-1",
      justification: "string",
    },
    secondaryConfirmation: false,
    multiModelVoting: false,
    structuredReasonOutput: true,
  };
}

export async function GET() {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ data: null });

  let config = await prisma.llmProviderConfig.findFirst({
    where: { userId: user.id, isDefault: true },
  });

  if (!config) {
    const defaults = buildEnvLlmDefaults();
    config = await prisma.llmProviderConfig.create({
      data: {
        userId: user.id,
        isDefault: true,
        provider: defaults.provider,
        model: defaults.model,
        apiKeyMasked: maskSecret(defaults.apiKey),
        encryptedApiKey: encryptText(defaults.apiKey),
        baseUrl: defaults.baseUrl,
        temperature: defaults.temperature,
        maxTokens: defaults.maxTokens,
        systemPrompt: defaults.systemPrompt,
        tradingPrompt: defaults.tradingPrompt,
        decisionSchema: defaults.decisionSchema as Prisma.InputJsonValue,
        secondaryConfirmation: defaults.secondaryConfirmation,
        multiModelVoting: defaults.multiModelVoting,
        structuredReasonOutput: defaults.structuredReasonOutput,
      },
    });
    await syncDefaultUserConfig(user.id);
  }

  return NextResponse.json({
    data: config
      ? {
          ...config,
          apiKeyMasked: maskSecret(config.apiKeyMasked),
          encryptedApiKey: undefined,
        }
      : null,
  });
}

export async function POST(request: NextRequest) {
  const payload = llmSchema.parse(await request.json());
  const { apiKey, decisionSchema, ...rest } = payload;

  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const existing = await prisma.llmProviderConfig.findFirst({ where: { userId: user.id, isDefault: true } });

  const saved = existing
    ? await prisma.llmProviderConfig.update({
        where: { id: existing.id },
        data: {
          ...rest,
          decisionSchema: decisionSchema as Prisma.InputJsonValue,
          apiKeyMasked: maskSecret(apiKey),
          encryptedApiKey: encryptText(apiKey),
        },
      })
    : await prisma.llmProviderConfig.create({
        data: {
          ...rest,
          decisionSchema: decisionSchema as Prisma.InputJsonValue,
          userId: user.id,
          apiKeyMasked: maskSecret(apiKey),
          encryptedApiKey: encryptText(apiKey),
          isDefault: true,
        },
      });

  await syncDefaultUserConfig(user.id);

  return NextResponse.json({ id: saved.id });
}
