import { logger } from "@/lib/logger";

type OutboundLogContext = {
  channel: "okx" | "llm" | "network";
  method: string;
  url: string;
  meta?: Record<string, unknown>;
};

type OutboundLogHandle = OutboundLogContext & {
  startedAt: number;
  requestId: string;
};

const SENSITIVE_KEYS = ["authorization", "ok-access-key", "ok-access-sign", "ok-access-passphrase", "apiKey", "apiSecret", "passphrase", "key", "secret", "token"];
const OUTBOUND_LOG_DETAIL = (process.env.OUTBOUND_LOG_DETAIL || "compact").toLowerCase();
const OUTBOUND_LOG_ENABLED = process.env.OUTBOUND_LOG_ENABLED === "1";

function isSensitiveKey(key: string) {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((item) => lower.includes(item.toLowerCase()));
}

function redactValue(value: unknown) {
  if (typeof value === "string") {
    if (value.length <= 8) return "***";
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }
  return "***";
}

function compactUnknown(input: unknown, depth = 0): unknown {
  if (input == null) return input;
  if (typeof input === "string") {
    return input.length > 160 ? `${input.slice(0, 160)}...` : input;
  }
  if (typeof input === "number" || typeof input === "boolean") return input;

  if (Array.isArray(input)) {
    if (depth >= 1) return `[Array(${input.length})]`;
    const sample = input.slice(0, 2).map((item) => compactUnknown(item, depth + 1));
    return input.length > 2 ? [...sample, `...(+${input.length - 2})`] : sample;
  }

  if (typeof input === "object") {
    if (depth >= 2) return "[Object]";
    const entries = Object.entries(input as Record<string, unknown>);
    const filtered = entries.filter(([key]) => !["headers", "response", "data", "raw"].includes(key));
    const picked = (filtered.length > 0 ? filtered : entries).slice(0, 6);
    const out: Record<string, unknown> = {};
    for (const [key, value] of picked) {
      out[key] = compactUnknown(value, depth + 1);
    }
    if (entries.length > picked.length) {
      out.__more = `+${entries.length - picked.length} fields`;
    }
    return out;
  }

  return String(input);
}

function normalizeMetaForLog(meta: Record<string, unknown> | undefined) {
  if (!meta) return undefined;
  const redacted = redactObject(meta) as Record<string, unknown>;
  if (OUTBOUND_LOG_DETAIL === "full") return redacted;
  return compactUnknown(redacted);
}

function getTargetLabel(channel: OutboundLogContext["channel"]) {
  if (channel === "okx") return "OKX";
  if (channel === "llm") return "LLM";
  return "NETWORK";
}

export function redactObject(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((item) => redactObject(item));
  }

  if (input && typeof input === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        output[key] = redactValue(value);
      } else {
        output[key] = redactObject(value);
      }
    }
    return output;
  }

  return input;
}

export function logOutboundRequestStart(context: OutboundLogContext): OutboundLogHandle {
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const handle: OutboundLogHandle = {
    ...context,
    startedAt: Date.now(),
    requestId,
  };

  if (!OUTBOUND_LOG_ENABLED) {
    return handle;
  }

  const target = getTargetLabel(handle.channel);

  logger.info(
    {
      event: "outbound_request_start",
      phase: "request",
      requestId: handle.requestId,
      target,
      channel: handle.channel,
      method: handle.method,
      url: handle.url,
      meta: normalizeMetaForLog(handle.meta),
    },
    `OUTBOUND [${handle.requestId}] REQUEST -> ${target} ${handle.method.toUpperCase()} ${handle.url}`,
  );

  return handle;
}

export function logOutboundRequestSuccess(handle: OutboundLogHandle, status: number, meta?: Record<string, unknown>) {
  if (!OUTBOUND_LOG_ENABLED) {
    return;
  }

  const target = getTargetLabel(handle.channel);
  logger.info(
    {
      event: "outbound_request_success",
      phase: "response",
      requestId: handle.requestId,
      target,
      channel: handle.channel,
      method: handle.method,
      url: handle.url,
      status,
      durationMs: Date.now() - handle.startedAt,
      meta: normalizeMetaForLog(meta),
    },
    `OUTBOUND [${handle.requestId}] RESPONSE <- ${target} ${handle.method.toUpperCase()} ${handle.url} [${status}]`,
  );
}

export function logOutboundRequestError(
  handle: OutboundLogHandle,
  error: unknown,
  meta?: Record<string, unknown>,
) {
  if (!OUTBOUND_LOG_ENABLED) {
    return;
  }

  const normalized = error instanceof Error ? error : new Error(String(error));
  const maybeCode = normalized as Error & { code?: string };
  const target = getTargetLabel(handle.channel);

  logger.error(
    {
      event: "outbound_request_error",
      phase: "error",
      requestId: handle.requestId,
      target,
      channel: handle.channel,
      method: handle.method,
      url: handle.url,
      durationMs: Date.now() - handle.startedAt,
      error: {
        name: normalized.name,
        message: normalized.message,
        code: maybeCode.code || null,
      },
      meta: normalizeMetaForLog(meta),
    },
    `OUTBOUND [${handle.requestId}] ERROR xx ${target} ${handle.method.toUpperCase()} ${handle.url}`,
  );
}
