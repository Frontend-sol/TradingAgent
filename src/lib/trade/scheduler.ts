import cron, { ScheduledTask } from "node-cron";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { DEMO_USER_EMAIL } from "@/lib/utils";
import { runStrategyForSymbols } from "@/lib/trade/demo-strategy";

let activeTask: ScheduledTask | null = null;
let activeStrategyId: string | null = null;
let activeCronExpression: string | null = null;
let activeRun = false;
let activeRunStartedAt: Date | null = null;
const schedulerOwner = randomUUID();

function barToCron(bar: string) {
  switch (bar) {
    case "15s":
      return "*/15 * * * * *";
    case "1m":
      return "*/1 * * * *";
    case "3m":
      return "*/3 * * * *";
    case "5m":
      return "*/5 * * * *";
    case "15m":
      return "*/15 * * * *";
    case "1h":
      return "0 * * * *";
    default:
      return "*/5 * * * *";
  }
}

function barToMs(bar: string) {
  switch (bar) {
    case "15s":
      return 15 * 1000;
    case "1m":
      return 60 * 1000;
    case "3m":
      return 3 * 60 * 1000;
    case "5m":
      return 5 * 60 * 1000;
    case "15m":
      return 15 * 60 * 1000;
    case "1h":
      return 60 * 60 * 1000;
    default:
      return 5 * 60 * 1000;
  }
}

async function acquireScheduledRun(strategyId: string, options: { ignoreInterval?: boolean } = {}) {
  const latest = await prisma.strategyConfig.findUnique({ where: { id: strategyId } });
  if (!latest || !latest.autoTradingEnabled) return { acquired: false, strategy: latest, reason: "disabled_or_missing" };

  const now = new Date();
  const intervalMs = barToMs(latest.timeframe);
  const minPreviousRunAt = new Date(now.getTime() - intervalMs);
  const lockUntil = new Date(now.getTime() + Math.max(intervalMs, 10 * 60 * 1000));

  const locked = await prisma.strategyConfig.updateMany({
    where: {
      id: strategyId,
      autoTradingEnabled: true,
      OR: [
        { schedulerLockedUntil: null },
        { schedulerLockedUntil: { lt: now } },
      ],
      ...(options.ignoreInterval
        ? {}
        : {
            AND: [
              {
                OR: [
                  { lastRunStartedAt: null },
                  { lastRunStartedAt: { lte: minPreviousRunAt } },
                ],
              },
            ],
          }),
    },
    data: {
      lastRunStartedAt: now,
      schedulerLockedUntil: lockUntil,
      schedulerOwner,
    },
  });

  if (locked.count !== 1) {
    return { acquired: false, strategy: latest, reason: "period_not_elapsed_or_locked" };
  }

  return { acquired: true, strategy: latest, reason: null };
}

async function releaseScheduledRun(strategyId: string) {
  await prisma.strategyConfig.updateMany({
    where: {
      id: strategyId,
      schedulerOwner,
    },
    data: {
      lastRunFinishedAt: new Date(),
      schedulerLockedUntil: null,
      schedulerOwner: null,
    },
  });
}

async function executeScheduledRun(strategyId: string, options: { ignoreInterval?: boolean; trigger?: "cron" | "manual_start" } = {}) {
  if (activeRun) {
    console.warn("[trade-scheduler] previous strategy run is still active; skip overlapping tick", {
      strategyId,
      activeRunStartedAt: activeRunStartedAt?.toISOString() || null,
      trigger: options.trigger || "cron",
    });
    return;
  }

  activeRun = true;
  activeRunStartedAt = new Date();
  try {
    console.info("[trade-scheduler] strategy run requested", {
      strategyId,
      trigger: options.trigger || "cron",
      ignoreInterval: Boolean(options.ignoreInterval),
    });

    const lease = await acquireScheduledRun(strategyId, { ignoreInterval: options.ignoreInterval });
    const latest = lease.strategy;
    if (!lease.acquired || !latest) {
      if (lease.reason === "period_not_elapsed_or_locked") {
        console.info("[trade-scheduler] skip tick before configured interval elapsed", {
          strategyId,
          trigger: options.trigger || "cron",
        });
      }
      return;
    }

    const latestExpression = barToCron(latest.timeframe);
    if (activeCronExpression && latestExpression !== activeCronExpression) {
      console.warn("[trade-scheduler] strategy timeframe changed; skip stale cron tick", {
        strategyId,
        activeCronExpression,
        latestExpression,
        latestTimeframe: latest.timeframe,
      });
      return;
    }

    if (latest.enableAiListener) {
      console.info("[trade-scheduler] AI listener enabled; running strategy", {
        strategyId: latest.id,
        symbols: latest.symbols.length ? latest.symbols : ["BTC-USDT"],
        trigger: options.trigger || "cron",
      });
      await runStrategyForSymbols(latest.symbols.length ? latest.symbols : ["BTC-USDT"], latest.id);
    } else {
      console.info("[trade-scheduler] AI listener disabled; skip LLM strategy", {
        strategyId: latest.id,
        trigger: options.trigger || "cron",
      });
    }

    if (latest.enableTradingviewListener) {
      console.info("[trade-scheduler] TradingView listener enabled; webhook execution path is reserved", {
        strategyId: latest.id,
        timeframe: latest.timeframe,
      });
    }
  } finally {
    await releaseScheduledRun(strategyId);
    activeRun = false;
    activeRunStartedAt = null;
  }
}

function startImmediateRun(strategyId: string) {
  void executeScheduledRun(strategyId, { ignoreInterval: true, trigger: "manual_start" }).catch((error) => {
    console.error("[trade-scheduler] immediate strategy run failed", {
      strategyId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function startTradingTask() {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) throw new Error("demo user missing");

  const strategy = await prisma.strategyConfig.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } });
  if (!strategy) throw new Error("strategy missing");

  const saved = await prisma.strategyConfig.update({
    where: { id: strategy.id },
    data: { autoTradingEnabled: true },
  });

  const expression = barToCron(saved.timeframe);

  if (activeTask && activeStrategyId === saved.id && activeCronExpression === expression) {
    startImmediateRun(saved.id);
    return {
      expression,
      timeframe: saved.timeframe,
      strategyId: saved.id,
      alreadyRunning: true,
      immediateRun: true,
      lastRunStartedAt: saved.lastRunStartedAt,
      lastRunFinishedAt: saved.lastRunFinishedAt,
    };
  }

  if (activeTask) {
    activeTask.stop();
    activeTask.destroy();
    activeTask = null;
  }

  activeStrategyId = saved.id;
  activeCronExpression = expression;

  activeTask = cron.schedule(expression, async () => {
    if (!activeStrategyId) return;
    await executeScheduledRun(activeStrategyId);
  });

  startImmediateRun(saved.id);

  return {
    expression,
    timeframe: saved.timeframe,
    strategyId: saved.id,
    alreadyRunning: false,
    immediateRun: true,
    lastRunStartedAt: saved.lastRunStartedAt,
    lastRunFinishedAt: saved.lastRunFinishedAt,
  };
}

export function stopTradingTask() {
  void (async () => {
    const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
    if (!user) return;
    const strategy = await prisma.strategyConfig.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } });
    if (!strategy) return;
    await prisma.strategyConfig.update({
      where: { id: strategy.id },
      data: {
        autoTradingEnabled: false,
        schedulerLockedUntil: null,
        schedulerOwner: null,
      },
    });
  })();

  if (activeTask) {
    activeTask.stop();
    activeTask.destroy();
  }
  activeTask = null;
  activeStrategyId = null;
  activeCronExpression = null;
  activeRun = false;
  activeRunStartedAt = null;
  return { stopped: true };
}

export async function getTradingTaskStatus() {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  const strategy = user
    ? await prisma.strategyConfig.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } })
    : null;

  return {
    running: Boolean(strategy?.autoTradingEnabled),
    strategyId: strategy?.id || activeStrategyId,
    inMemoryTask: Boolean(activeTask),
    timeframe: strategy?.timeframe || null,
    cronExpression: activeCronExpression,
    enableAiListener: strategy?.enableAiListener ?? true,
    enableTradingviewListener: strategy?.enableTradingviewListener ?? false,
    activeRun,
    activeRunStartedAt: activeRunStartedAt?.toISOString() || null,
    lastRunStartedAt: strategy?.lastRunStartedAt?.toISOString() || null,
    lastRunFinishedAt: strategy?.lastRunFinishedAt?.toISOString() || null,
    schedulerLockedUntil: strategy?.schedulerLockedUntil?.toISOString() || null,
  };
}
