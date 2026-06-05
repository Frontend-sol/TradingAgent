import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateEquityCurve } from "@/lib/mock-data";
import { DEMO_USER_EMAIL } from "@/lib/utils";
import { okxAdapter } from "@/lib/okx/adapter";

export const dynamic = "force-dynamic";

function serializeDate(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}

function serializeRows<T extends { createdAt?: Date | string; updatedAt?: Date | string }>(rows: T[]) {
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt ? serializeDate(row.createdAt) : row.createdAt,
    updatedAt: row.updatedAt ? serializeDate(row.updatedAt) : row.updatedAt,
  }));
}

function buildThreeDayEquityCurve(rows: Array<{ equity: number; snapshotAt: Date }>) {
  const now = new Date();
  const start = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const bucketMs = 3 * 60 * 60 * 1000;
  const buckets: Array<{ date: string; equity: number | null }> = [];

  for (let ts = start.getTime(); ts <= now.getTime(); ts += bucketMs) {
    buckets.push({ date: new Date(ts).toLocaleString(), equity: null });
  }

  const sorted = [...rows].sort((a, b) => a.snapshotAt.getTime() - b.snapshotAt.getTime());
  for (const row of sorted) {
    const index = Math.min(
      buckets.length - 1,
      Math.max(0, Math.floor((row.snapshotAt.getTime() - start.getTime()) / bucketMs)),
    );
    buckets[index].equity = row.equity;
  }

  let lastEquity: number | null = null;
  return buckets
    .map((bucket) => {
      if (bucket.equity != null) lastEquity = bucket.equity;
      return lastEquity == null ? null : { date: bucket.date, equity: lastEquity };
    })
    .filter((item): item is { date: string; equity: number } => item != null);
}

export async function GET() {
  try {
    const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });

    if (!user) {
      return NextResponse.json({
        metrics: null,
        equityCurve: generateEquityCurve(30),
        latestTradingViewLogs: [],
        latestTrades: [],
        latestDecisions: [],
        okxStatus: {
          configured: false,
          message: "尚未初始化账户，请先在系统配置中同步 OKX 账户信息。",
        },
      });
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const snapshotStart = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    const [latestTrades, latestDecisions, latestTradingViewLogs, okxAccount, pnlRows, accountSnapshots] = await Promise.all([
      prisma.tradeOrder.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
      prisma.aiDecisionLog.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
      prisma.systemLog.findMany({
        where: { userId: user.id, category: "tradingview_webhook" },
        orderBy: { createdAt: "desc" },
        take: 12,
      }),
      prisma.exchangeAccount.findFirst({
        where: { userId: user.id, exchange: "okx", isDefault: true },
      }),
      prisma.pnLDaily.findMany({
        where: { userId: user.id },
        orderBy: { date: "desc" },
        take: 365,
      }),
      prisma.accountSnapshot.findMany({
        where: { userId: user.id, snapshotAt: { gte: snapshotStart } },
        orderBy: { snapshotAt: "asc" },
        select: { equity: true, snapshotAt: true },
      }),
    ]);

    const todayRow = pnlRows.find((row) => row.date >= todayStart);
    const pnlToday = todayRow ? todayRow.realizedPnl + todayRow.unrealizedPnl - todayRow.feeTotal : 0;
    const pnlTotal = pnlRows.length
      ? pnlRows.reduce((sum, row) => sum + row.realizedPnl + row.unrealizedPnl - row.feeTotal, 0)
      : 0;
    const okxConfigured =
      Boolean(okxAccount) &&
      Boolean(okxAccount?.apiKeyMasked) &&
      Boolean(okxAccount?.encryptedApiKey) &&
      Boolean(okxAccount?.encryptedSecret) &&
      Boolean(okxAccount?.encryptedPassphrase) &&
      !okxAccount?.encryptedSecret.startsWith("encrypted:demo_");

    let equity: number | null = null;
    let available: number | null = null;
    let positionCount = 0;
    let dataSource: "okx" | "fallback" = "fallback";
    let okxStatusMessage = okxConfigured
      ? "OKX 账户已同步。"
      : "OKX 账户信息未完整配置，请前往系统配置同步 API Key / Secret / Passphrase。";

    if (okxConfigured && okxAccount) {
      try {
        const [balanceRaw, positionsRaw] = await Promise.all([
          okxAdapter.getBalance(okxAccount.envType),
          okxAdapter.getPositions("SWAP", okxAccount.envType),
        ]);

        const accountBalance = (balanceRaw?.[0] || {}) as Record<string, unknown>;
        const details = (accountBalance.details as Array<Record<string, unknown>> | undefined)?.[0] || {};

        const totalEqRaw = accountBalance.totalEq ?? accountBalance.adjEq;
        const availRaw = details.availEq ?? accountBalance.availEq;

        if (typeof totalEqRaw === "string" || typeof totalEqRaw === "number") {
          equity = Number(totalEqRaw);
        }
        if (typeof availRaw === "string" || typeof availRaw === "number") {
          available = Number(availRaw);
        }
        if (equity != null || available != null) {
          await prisma.accountSnapshot.create({
            data: {
              userId: user.id,
              equity: equity ?? available ?? 0,
              balance: equity ?? available ?? 0,
              available: available ?? equity ?? 0,
              marginRatio: null,
              totalUnrealized: null,
            },
          });
          accountSnapshots.push({ equity: equity ?? available ?? 0, snapshotAt: new Date() });
        }
        positionCount = Array.isArray(positionsRaw) ? positionsRaw.length : 0;
        dataSource = "okx";
        okxStatusMessage = "OKX 账户已同步，Dashboard 正在展示实时账户数据。";
      } catch (error) {
        okxStatusMessage =
          error instanceof Error
            ? `OKX 数据拉取失败：${error.message}`
            : "OKX 数据拉取失败，请检查配置或网络连接。";
      }
    }

    return NextResponse.json({
      metrics: {
        equity,
        available,
        positionCount,
        pnlToday,
        pnlTotal,
        dataSource,
        strategyStatus: "running",
        aiStatus: "active",
        runtimeMode: "demo-analysis",
      },
      equityCurve: accountSnapshots.length ? buildThreeDayEquityCurve(accountSnapshots) : generateEquityCurve(24),
      latestTradingViewLogs: serializeRows(latestTradingViewLogs),
      latestTrades: serializeRows(latestTrades),
      latestDecisions: serializeRows(latestDecisions),
      okxStatus: {
        configured: okxConfigured,
        message: okxStatusMessage,
      },
      riskAlerts: [
        { level: "low", message: "当前回撤 3.2%，低于阈值" },
        { level: "medium", message: "BTC 波动率升高，建议降低仓位" },
      ],
    });
  } catch (error) {
    console.error("[dashboard-overview] failed", error);
    return NextResponse.json(
      {
        metrics: {
          equity: null,
          available: null,
          positionCount: 0,
          pnlToday: 0,
          pnlTotal: 0,
          dataSource: "fallback",
          strategyStatus: "unknown",
          aiStatus: "unknown",
          runtimeMode: "unknown",
        },
        equityCurve: generateEquityCurve(24),
        latestTradingViewLogs: [],
        latestTrades: [],
        latestDecisions: [],
        okxStatus: {
          configured: false,
          message: error instanceof Error ? `Dashboard 数据加载失败：${error.message}` : "Dashboard 数据加载失败。",
        },
        riskAlerts: [],
      },
      { status: 200 },
    );
  }
}
