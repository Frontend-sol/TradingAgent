import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { okxAdapter } from "@/lib/okx/adapter";
import { DEMO_USER_EMAIL } from "@/lib/utils";

const TRACKED_SYMBOLS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP", "XRP-USDT-SWAP"];

type PositionRow = {
  instId?: string;
  pos?: string;
  upl?: string;
  uplRatio?: string;
  avgPx?: string;
  markPx?: string;
  lever?: string;
  posSide?: string;
};

function asNumber(value: unknown, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toPercent(value: number) {
  return `${value.toFixed(2)}%`;
}

async function resolveDefaultEnv() {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return "demo" as const;

  const account = await prisma.exchangeAccount.findFirst({
    where: { userId: user.id, exchange: "okx", isDefault: true },
    select: { envType: true },
  });

  return account?.envType || "demo";
}

async function buildRealtimeSnapshot() {
  const env = await resolveDefaultEnv();

  const [tickers, balanceRaw, positionsRaw] = await Promise.all([
    Promise.all(TRACKED_SYMBOLS.map((instId) => okxAdapter.getTicker(instId))),
    okxAdapter.getBalance(env),
    okxAdapter.getPositions("SWAP", env),
  ]);

  const marketCards = TRACKED_SYMBOLS.map((instId, index) => {
    const ticker = (tickers[index] || {}) as Record<string, unknown>;
    const last = asNumber(ticker.last);
    const open24h = asNumber(ticker.open24h, last || 1);
    const change24h = open24h > 0 ? ((last - open24h) / open24h) * 100 : 0;

    return {
      symbol: instId,
      last: last.toFixed(4),
      change24h: change24h,
      change24hText: toPercent(change24h),
      vol24h: String(ticker.vol24h || "0"),
    };
  });

  const positions = (Array.isArray(positionsRaw) ? positionsRaw : []) as PositionRow[];
  const positionCards = positions
    .filter((item) => TRACKED_SYMBOLS.includes(String(item.instId || "")))
    .map((item) => {
      const upl = asNumber(item.upl);
      const uplRatio = asNumber(item.uplRatio) * 100;
      return {
        symbol: String(item.instId || "-"),
        side: String(item.posSide || "net"),
        size: String(item.pos || "0"),
        leverage: String(item.lever || "-"),
        avgPx: String(item.avgPx || "-"),
        markPx: String(item.markPx || "-"),
        upl,
        uplText: upl.toFixed(4),
        uplRatio,
        uplRatioText: toPercent(uplRatio),
      };
    });

  const totalUpl = positionCards.reduce((sum, item) => sum + item.upl, 0);
  const accountBalance = (Array.isArray(balanceRaw) ? balanceRaw[0] : null) as
    | { totalEq?: string; details?: Array<Record<string, unknown>> }
    | null;
  const details = accountBalance?.details || [];
  const usdt = details.find((item) => String(item.ccy) === "USDT") || {};

  return {
    ts: Date.now(),
    env,
    marketCards,
    positionCards,
    summary: {
      equity: asNumber(accountBalance?.totalEq).toFixed(4),
      usdtAvailable: asNumber(usdt.availBal).toFixed(4),
      openPositions: positionCards.length,
      totalUpl,
      totalUplText: totalUpl.toFixed(4),
    },
  };
}

function encoder(data: unknown) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: Request) {
  let closed = false;
  let controllerClosed = false;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const stream = new ReadableStream({
    async start(controller) {
      const stop = () => {
        closed = true;
      };

      request.signal.addEventListener("abort", stop);

      while (!closed) {
        try {
          const snapshot = await buildRealtimeSnapshot();
          controller.enqueue(encoder(snapshot));
        } catch (error) {
          try {
            controller.enqueue(
              encoder({
                ts: Date.now(),
                error: error instanceof Error ? error.message : "实时数据拉取失败",
                marketCards: [],
                positionCards: [],
                summary: {
                  equity: "0",
                  usdtAvailable: "0",
                  openPositions: 0,
                  totalUpl: 0,
                  totalUplText: "0",
                },
              }),
            );
          } catch {
            closed = true;
            break;
          }
        }

        await sleep(300000);
      }

      if (!controllerClosed) {
        controllerClosed = true;
        try {
          controller.close();
        } catch {
          // Ignore close errors when controller is already closed by runtime.
        }
      }

      request.signal.removeEventListener("abort", stop);
    },
    cancel() {
      closed = true;
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
