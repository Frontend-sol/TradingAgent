import axios from "axios";
import { logOutboundRequestError, logOutboundRequestStart, logOutboundRequestSuccess } from "@/lib/http-log";
import { aiDecisionSchema, type AiDecision } from "./schema";

interface LlmMessage {
  role: "system" | "user";
  content: string;
}

interface LlmConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
}

function normalizeOpenAIResponse(raw: unknown) {
  const content =
    (raw as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content || "{}";
  return content;
}

function previewText(text: string, max = 240) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function isDeepSeekConfig(config: Pick<LlmConfig, "provider" | "baseUrl" | "model">) {
  const provider = config.provider.toLowerCase();
  const baseUrl = config.baseUrl.toLowerCase();
  const model = config.model.toLowerCase();
  return provider.includes("deepseek") || baseUrl.includes("deepseek") || model.includes("deepseek");
}

function safeParseDecision(content: string): AiDecision {
  const trimmed = content.trim();
  const maybeJson = trimmed.startsWith("```")
    ? trimmed.replace(/^```json\s*/i, "").replace(/^```/, "").replace(/```$/, "")
    : trimmed;

  const parsed = JSON.parse(maybeJson);
  return aiDecisionSchema.parse(parsed);
}

export async function runLlmDecision(messages: LlmMessage[], config: LlmConfig): Promise<AiDecision> {
  const isOpenAICompatible = ["openai", "openrouter", "custom", "anthropic", "gemini"].includes(
    config.provider.toLowerCase(),
  );

  if (!isOpenAICompatible) {
    throw new Error(`Unsupported provider: ${config.provider}`);
  }

  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const requestLog = logOutboundRequestStart({
    channel: "llm",
    method: "POST",
    url,
    meta: {
      provider: config.provider,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      messageCount: messages.length,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    },
  });

  try {
    const response = await axios.post(
      url,
      {
        model: config.model,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        ...(!isDeepSeekConfig(config) ? { response_format: { type: "json_object" } } : {}),
        messages,
      },
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      },
    );

    const content = normalizeOpenAIResponse(response.data);
    logOutboundRequestSuccess(requestLog, response.status, {
      provider: config.provider,
      model: config.model,
      hasChoices: Array.isArray((response.data as { choices?: unknown[] })?.choices),
      responsePreview: previewText(content),
    });
    return safeParseDecision(content);
  } catch (error) {
    const maybeError = error as { response?: { status?: number; data?: unknown } };
    logOutboundRequestError(requestLog, error, {
      status: maybeError.response?.status || null,
      response: maybeError.response?.data || null,
      provider: config.provider,
      model: config.model,
    });
    throw error;
  }
}
