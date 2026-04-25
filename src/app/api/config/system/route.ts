import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { EnvType, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { encryptText } from "@/lib/crypto";
import { DEMO_USER_EMAIL, maskSecret } from "@/lib/utils";

export const dynamic = "force-dynamic";

const llmSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  apiKey: z.string().optional().default(""),
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

const okxSchema = z.object({
  label: z.string().min(1),
  envType: z.nativeEnum(EnvType),
  apiKey: z.string().optional().default(""),
  apiSecret: z.string().optional().default(""),
  passphrase: z.string().optional().default(""),
  readOnly: z.boolean(),
  enableAutoTrading: z.boolean(),
});

const payloadSchema = z.object({
  llm: llmSchema,
  okx: okxSchema,
});

function isMaskedInput(value: string) {
  const text = value.trim();
  if (!text) return true;
  if (/^\*+$/.test(text)) return true;
  return text.includes("****");
}

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

  const [existingLlm, okx] = await Promise.all([
    prisma.llmProviderConfig.findFirst({ where: { userId: user.id, isDefault: true } }),
    prisma.exchangeAccount.findFirst({ where: { userId: user.id, exchange: "okx", isDefault: true } }),
  ]);
  let llm = existingLlm;

  if (!llm) {
    const defaults = buildEnvLlmDefaults();
    llm = await prisma.llmProviderConfig.create({
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
  }

  return NextResponse.json({
    data: {
      llm: llm
        ? {
            provider: llm.provider,
            model: llm.model,
            apiKeyMasked: llm.apiKeyMasked,
            baseUrl: llm.baseUrl,
            temperature: llm.temperature,
            maxTokens: llm.maxTokens,
            systemPrompt: llm.systemPrompt,
            tradingPrompt: llm.tradingPrompt,
            decisionSchema: llm.decisionSchema,
            secondaryConfirmation: llm.secondaryConfirmation,
            multiModelVoting: llm.multiModelVoting,
            structuredReasonOutput: llm.structuredReasonOutput,
          }
        : null,
      okx: okx
        ? {
            label: okx.label,
            envType: okx.envType,
            apiKeyMasked: maskSecret(okx.apiKeyMasked),
            hasApiKey: Boolean(okx.encryptedApiKey),
            hasSecret: Boolean(okx.encryptedSecret),
            hasPassphrase: Boolean(okx.encryptedPassphrase),
            readOnly: okx.readOnly,
            enableAutoTrading: okx.enableAutoTrading,
          }
        : null,
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const raw = await request.json();
    const parsed = payloadSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return NextResponse.json(
        {
          error: "配置参数校验失败",
          message: `${issue.path.join(".") || "payload"}: ${issue.message}`,
        },
        { status: 400 },
      );
    }

    const payload = parsed.data;
    const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const [existingLlm, existingOkx] = await Promise.all([
      prisma.llmProviderConfig.findFirst({ where: { userId: user.id, isDefault: true } }),
      prisma.exchangeAccount.findFirst({ where: { userId: user.id, exchange: "okx", isDefault: true } }),
    ]);

    const llmApiKey = payload.llm.apiKey.trim();
    const shouldUpdateLlmKey = !isMaskedInput(llmApiKey);
    const llmData = {
      provider: payload.llm.provider,
      model: payload.llm.model,
      baseUrl: payload.llm.baseUrl,
      temperature: payload.llm.temperature,
      maxTokens: payload.llm.maxTokens,
      systemPrompt: payload.llm.systemPrompt,
      tradingPrompt: payload.llm.tradingPrompt,
      decisionSchema: payload.llm.decisionSchema as Prisma.InputJsonValue,
      secondaryConfirmation: payload.llm.secondaryConfirmation,
      multiModelVoting: payload.llm.multiModelVoting,
      structuredReasonOutput: payload.llm.structuredReasonOutput,
      ...(shouldUpdateLlmKey
        ? {
            apiKeyMasked: maskSecret(llmApiKey),
            encryptedApiKey: encryptText(llmApiKey),
          }
        : {}),
    };

    const llmSaved = existingLlm
      ? await prisma.llmProviderConfig.update({
          where: { id: existingLlm.id },
          data: llmData,
        })
      : await prisma.llmProviderConfig.create({
          data: {
            userId: user.id,
            isDefault: true,
            apiKeyMasked: shouldUpdateLlmKey ? maskSecret(llmApiKey) : "sk-****",
            encryptedApiKey: shouldUpdateLlmKey ? encryptText(llmApiKey) : "",
            ...llmData,
          },
        });

    const okxApiKey = payload.okx.apiKey.trim();
    const okxApiSecret = payload.okx.apiSecret.trim();
    const okxPassphrase = payload.okx.passphrase.trim();
    const shouldUpdateOkxKey = !isMaskedInput(okxApiKey);
    const shouldUpdateOkxSecret = !isMaskedInput(okxApiSecret);
    const shouldUpdateOkxPassphrase = !isMaskedInput(okxPassphrase);

    const okxData = {
      label: payload.okx.label,
      envType: payload.okx.envType,
      readOnly: payload.okx.readOnly,
      enableAutoTrading: payload.okx.enableAutoTrading,
      ...(shouldUpdateOkxKey ? { apiKeyMasked: maskSecret(okxApiKey) } : {}),
      ...(shouldUpdateOkxKey ? { encryptedApiKey: encryptText(okxApiKey) } : {}),
      ...(shouldUpdateOkxSecret ? { encryptedSecret: encryptText(okxApiSecret) } : {}),
      ...(shouldUpdateOkxPassphrase ? { encryptedPassphrase: encryptText(okxPassphrase) } : {}),
    };

    const okxSaved = existingOkx
      ? await prisma.exchangeAccount.update({ where: { id: existingOkx.id }, data: okxData })
      : await prisma.exchangeAccount.create({
          data: {
            userId: user.id,
            exchange: "okx",
            isDefault: true,
            apiKeyMasked: shouldUpdateOkxKey ? maskSecret(okxApiKey) : "okx_****",
            encryptedApiKey: shouldUpdateOkxKey ? encryptText(okxApiKey) : "",
            encryptedSecret: shouldUpdateOkxSecret ? encryptText(okxApiSecret) : "",
            encryptedPassphrase: shouldUpdateOkxPassphrase ? encryptText(okxPassphrase) : "",
            ...okxData,
          },
        });

    revalidatePath("/settings");
    revalidatePath("/dashboard");
    revalidatePath("/api/dashboard/overview");

    return NextResponse.json({
      data: {
        llmId: llmSaved.id,
        okxId: okxSaved.id,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json(
      {
        error: "配置保存失败",
        message,
      },
      { status: 500 },
    );
  }
}
