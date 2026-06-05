import { decryptText } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { DEMO_USER_EMAIL } from "@/lib/utils";
import { OkxClient } from "./client";
import type { OkxEnv, OkxOrderRequest } from "./types";

export class OkxError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hint: string,
  ) {
    super(message);
  }
}

function mapOkxError(code: string, msg: string) {
  const mapping: Record<string, { message: string; hint: string }> = {
    "50113": { message: "签名错误", hint: "请检查 API Key/Secret/Passphrase 是否正确" },
    "50102": { message: "时间戳不同步", hint: "请校准本地服务器时间" },
    "50011": { message: "请求频率限制", hint: "请降低请求频率并启用重试" },
    "51008": { message: "订单被拒绝", hint: "请检查保证金、杠杆和下单参数" },
    "51010": { message: "环境不匹配", hint: "Demo 与 Live 密钥不可混用" },
    "51000": { message: "参数不合法", hint: "请检查 instId、数量、价格等参数" },
  };

  const hit = mapping[code];
  if (hit) return new OkxError(code, hit.message, hit.hint);
  return new OkxError(code, msg || "OKX 接口错误", "请查看系统日志并重试");
}

async function getDefaultOkxClient(env: OkxEnv = "demo") {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) throw new Error("Demo user not found. Please run prisma seed.");

  const account = await prisma.exchangeAccount.findFirst({
    where: { userId: user.id, exchange: "okx", envType: env, isDefault: true },
  });

  if (!account) return new OkxClient(env);

  return new OkxClient(env, {
    apiKey: process.env.OKX_API_KEY || decryptText(account.encryptedApiKey),
    apiSecret: process.env.OKX_API_SECRET || decryptText(account.encryptedSecret),
    passphrase: process.env.OKX_API_PASSPHRASE || decryptText(account.encryptedPassphrase),
  });
}

export const okxAdapter = {
  async getInstruments(instType = "SWAP") {
    const client = await getDefaultOkxClient();
    const response = await client.getPublic<Record<string, string>>("/api/v5/public/instruments", {
      instType,
    });
    if (response.code !== "0") throw mapOkxError(response.code, response.msg);
    return response.data;
  },

  async getTicker(instId: string) {
    const client = await getDefaultOkxClient();
    const response = await client.getPublic<Record<string, string>>("/api/v5/market/ticker", {
      instId,
    });
    if (response.code !== "0") throw mapOkxError(response.code, response.msg);
    return response.data[0] || null;
  },

  async getCandles(instId: string, bar = "15m", limit = 100) {
    const client = await getDefaultOkxClient();
    const response = await client.getPublic<string[]>("/api/v5/market/candles", {
      instId,
      bar,
      limit,
    });
    if (response.code !== "0") throw mapOkxError(response.code, response.msg);
    return response.data;
  },

  async getFundingRate(instId: string) {
    const client = await getDefaultOkxClient();
    const response = await client.getPublic<Record<string, string>>("/api/v5/public/funding-rate", {
      instId,
    });
    if (response.code !== "0") throw mapOkxError(response.code, response.msg);
    return response.data[0] || null;
  },

  async getOpenInterest(instId: string, instType = "SWAP") {
    const client = await getDefaultOkxClient();
    const response = await client.getPublic<Record<string, string>>("/api/v5/public/open-interest", {
      instType,
      instId,
    });
    if (response.code !== "0") throw mapOkxError(response.code, response.msg);
    return response.data[0] || null;
  },

  async getBalance(env: OkxEnv = "demo") {
    const client = await getDefaultOkxClient(env);
    const response = await client.getPrivate<Record<string, unknown>>("/api/v5/account/balance");
    if (response.code !== "0") throw mapOkxError(response.code, response.msg);
    return response.data;
  },

  async getPositions(instType = "SWAP", env: OkxEnv = "demo") {
    const client = await getDefaultOkxClient(env);
    const response = await client.getPrivate<Record<string, unknown>>("/api/v5/account/positions", {
      instType,
    });
    if (response.code !== "0") throw mapOkxError(response.code, response.msg);
    return response.data;
  },

  async getPendingOrders(instType = "SWAP", env: OkxEnv = "demo") {
    const client = await getDefaultOkxClient(env);
    const response = await client.getPrivate<Record<string, unknown>>("/api/v5/trade/orders-pending", {
      instType,
    });
    if (response.code !== "0") throw mapOkxError(response.code, response.msg);
    return response.data;
  },

  async getOrderHistory(instType = "SWAP", env: OkxEnv = "demo") {
    const client = await getDefaultOkxClient(env);
    const response = await client.getPrivate<Record<string, unknown>>("/api/v5/trade/orders-history", {
      instType,
    });
    if (response.code !== "0") throw mapOkxError(response.code, response.msg);
    return response.data;
  },

  async getOrder(instId: string, ordId: string, env: OkxEnv = "demo") {
    const client = await getDefaultOkxClient(env);
    const response = await client.getPrivate<Record<string, string>>("/api/v5/trade/order", {
      instId,
      ordId,
    });
    if (response.code !== "0") throw mapOkxError(response.code, response.msg);
    return response.data[0] || null;
  },

  async getFills(instId: string, ordId: string, env: OkxEnv = "demo") {
    const client = await getDefaultOkxClient(env);
    const response = await client.getPrivate<Record<string, string>>("/api/v5/trade/fills", {
      instType: "SWAP",
      instId,
      ordId,
    });
    if (response.code !== "0") throw mapOkxError(response.code, response.msg);
    return response.data;
  },

  async placeOrder(payload: OkxOrderRequest, env: OkxEnv = "demo") {
    const client = await getDefaultOkxClient(env);
    const response = await client.postPrivate<Record<string, string>>("/api/v5/trade/order", payload);
    if (response.code === "1" && response.data?.[0]) return response.data[0];
    if (response.code !== "0") throw mapOkxError(response.code, response.msg);
    return response.data[0] || null;
  },

  async cancelOrder(instId: string, ordId: string, env: OkxEnv = "demo") {
    const client = await getDefaultOkxClient(env);
    const response = await client.postPrivate<Record<string, string>>("/api/v5/trade/cancel-order", {
      instId,
      ordId,
    });
    if (response.code !== "0") throw mapOkxError(response.code, response.msg);
    return response.data[0] || null;
  },

  async batchCancelOrders(data: Array<{ instId: string; ordId: string }>, env: OkxEnv = "demo") {
    const client = await getDefaultOkxClient(env);
    const response = await client.postPrivate<Record<string, string>>("/api/v5/trade/cancel-batch-orders", data);
    if (response.code !== "0") throw mapOkxError(response.code, response.msg);
    return response.data;
  },

  async setLeverage(instId: string, lever: number, mgnMode: "cross" | "isolated", env: OkxEnv = "demo") {
    const client = await getDefaultOkxClient(env);
    const response = await client.postPrivate<Record<string, string>>("/api/v5/account/set-leverage", {
      instId,
      lever: `${lever}`,
      mgnMode,
    });
    if (response.code !== "0") throw mapOkxError(response.code, response.msg);
    return response.data[0] || null;
  },
};
