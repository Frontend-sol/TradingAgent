import cron, { ScheduledTask } from "node-cron";
import { prisma } from "@/lib/db";
import { DEMO_USER_EMAIL } from "@/lib/utils";
import { runStrategyForSymbols } from "@/lib/trade/demo-strategy";

let activeTask: ScheduledTask | null = null;
let activeStrategyId: string | null = null;
let activeCronExpression: string | null = null;

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
    return {
      expression,
      timeframe: saved.timeframe,
      strategyId: saved.id,
      alreadyRunning: true,
      immediateRun: false,
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
    const latest = await prisma.strategyConfig.findUnique({ where: { id: activeStrategyId } });
    if (!latest || !latest.autoTradingEnabled) return;
    await runStrategyForSymbols(latest.symbols.length ? latest.symbols : ["BTC-USDT"], latest.id);
  });

  return {
    expression,
    timeframe: saved.timeframe,
    strategyId: saved.id,
    alreadyRunning: false,
    immediateRun: false,
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
      data: { autoTradingEnabled: false },
    });
  })();

  if (activeTask) {
    activeTask.stop();
    activeTask.destroy();
  }
  activeTask = null;
  activeStrategyId = null;
  activeCronExpression = null;
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
  };
}
