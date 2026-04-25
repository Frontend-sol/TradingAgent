import { NextRequest, NextResponse } from "next/server";
import { EnvType } from "@prisma/client";
import { isAxiosError } from "axios";
import { lookup } from "dns/promises";
import { z } from "zod";
import { decryptText } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { DEMO_USER_EMAIL } from "@/lib/utils";
import { OkxClient } from "@/lib/okx/client";

const OKX_HOST = "www.okx.com";
const INVALID_DNS_ADDRESSES = new Set(["0.0.0.0", "::", "127.0.0.1", "::1"]);

const schema = z.object({
  envType: z.nativeEnum(EnvType),
  apiKey: z.string(),
  apiSecret: z.string(),
  passphrase: z.string(),
});

function isMasked(value: string) {
  if (!value?.trim()) return true;
  if (/^\*+$/.test(value.trim())) return true;
  return value.includes("****");
}

function mapOkxError(code: string, msg: string) {
  const mapping: Record<string, string> = {
    "50113": "签名错误，请检查 API Key / Secret / Passphrase。",
    "50102": "时间戳不同步，请校准服务器时间。",
    "50011": "请求过于频繁，请稍后重试。",
    "51010": "环境不匹配，请确认 Demo / Live 与密钥类型一致。",
    "50101": "API Key 不存在或已失效，请在 OKX 后台重新创建。",
    "50119": "API Key 权限不足，请为 Key 开启读取账户权限。",
    "51000": "参数不合法，请检查输入格式。",
  };
  return mapping[code] || msg || "连接失败，请检查网络与账户配置。";
}

function mapNetworkError(message: string) {
  const cleanMessage = (message || "").trim();
  if (!cleanMessage) {
    return "网络请求失败：未收到明确错误信息，请检查网络、代理与 API 域名连通性。";
  }

  const msg = cleanMessage.toLowerCase();
  if (msg.includes("econnrefused")) {
    return "连接被拒绝：通常是 DNS/代理将目标地址重定向到本地或无效地址，请检查系统 DNS、代理规则和 hosts。";
  }
  if (msg.includes("timeout")) {
    return "请求超时：请检查网络连通性，或稍后重试。";
  }
  if (msg.includes("enotfound") || msg.includes("eai_again")) {
    return "DNS 解析失败：请检查网络或代理配置。";
  }
  if (msg.includes("self signed") || msg.includes("certificate")) {
    return "TLS 证书校验失败：请检查本机时间、代理或证书设置。";
  }
  return `网络请求失败：${cleanMessage}`;
}

function isDnsRelatedError(message: string) {
  const msg = (message || "").toLowerCase();
  return (
    msg.includes("enotfound") ||
    msg.includes("eai_again") ||
    msg.includes("econnrefused") ||
    msg.includes("dns")
  );
}

async function checkOkxHostResolution() {
  const records = await lookup(OKX_HOST, { all: true });
  const addresses = records.map((item) => item.address);
  const hasInvalidAddress = addresses.some((address) => INVALID_DNS_ADDRESSES.has(address));
  const hasUsableAddress = addresses.some((address) => !INVALID_DNS_ADDRESSES.has(address));

  return {
    addresses,
    hasInvalidAddress,
    hasUsableAddress,
    blocked: addresses.length > 0 && hasInvalidAddress && !hasUsableAddress,
  };
}

export async function POST(request: NextRequest) {
  const payload = schema.parse(await request.json());
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) {
    return NextResponse.json({ ok: false, message: "用户不存在，请先初始化系统。" }, { status: 404 });
  }

  const existing = await prisma.exchangeAccount.findFirst({
    where: { userId: user.id, exchange: "okx", isDefault: true, envType: payload.envType },
  });

  const apiKey = isMasked(payload.apiKey)
    ? existing?.encryptedApiKey
      ? decryptText(existing.encryptedApiKey)
      : ""
    : payload.apiKey.trim();

  const apiSecret = isMasked(payload.apiSecret)
    ? existing?.encryptedSecret
      ? decryptText(existing.encryptedSecret)
      : ""
    : payload.apiSecret.trim();

  const passphrase = isMasked(payload.passphrase)
    ? existing?.encryptedPassphrase
      ? decryptText(existing.encryptedPassphrase)
      : ""
    : payload.passphrase.trim();

  if (!apiKey || !apiSecret || !passphrase) {
    return NextResponse.json(
      { ok: false, message: "缺少必要的凭证，请填写 API Key / Secret / Passphrase。" },
      { status: 400 },
    );
  }

  let dnsResolution:
    | {
        host: string;
        resolvedAddresses: string[];
        blocked: boolean;
      }
    | undefined;

  try {
    const resolution = await checkOkxHostResolution();
    dnsResolution = {
      host: OKX_HOST,
      resolvedAddresses: resolution.addresses,
      blocked: resolution.blocked,
    };
  } catch {
    // Ignore DNS precheck failures and continue to actual request for broader compatibility.
  }

  try {
    const client = new OkxClient(payload.envType, { apiKey, apiSecret, passphrase });
    const response = await client.getPrivate<Record<string, unknown>>("/api/v5/account/config");

    if (response.code !== "0") {
      return NextResponse.json({ ok: false, message: mapOkxError(response.code, response.msg) }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      message: `连接成功，当前环境：${payload.envType.toUpperCase()}。`,
    });
  } catch (error) {
    if (isAxiosError(error)) {
      const data = error.response?.data as { code?: string; msg?: string } | undefined;
      const code = data?.code;
      const msg = data?.msg || error.message || error.code || "";

      if (code) {
        return NextResponse.json(
          {
            ok: false,
            message: `连接失败（OKX ${code}）：${mapOkxError(code, msg)}`,
          },
          { status: 400 },
        );
      }

      return NextResponse.json(
        {
          ok: false,
          message:
            dnsResolution?.blocked && isDnsRelatedError(msg)
              ? "检测到 Node 运行时 DNS 解析异常（仅解析到 0.0.0.0/:: 或回环地址），请检查系统 DNS/代理/拦截规则后重试。"
              : mapNetworkError(msg),
          diagnostics: {
            axiosCode: error.code || null,
            httpStatus: error.response?.status || null,
            okxCode: code || null,
            dns: dnsResolution || null,
          },
        },
        { status: error.response?.status || 500 },
      );
    }

    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? `连接失败：${error.message}` : "连接失败，请检查网络或配置。",
      },
      { status: 500 },
    );
  }
}
