import { Queue, Worker, JobsOptions } from "bullmq";
import IORedis from "ioredis";
import { logger } from "@/lib/logger";
import { runDecisionEngine } from "@/lib/engine/decision-engine";
import { executeOrder } from "@/lib/engine/execution-engine";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

export const marketScanQueue = new Queue("market-scan", { connection });

export async function addMarketScanJob(data: { symbol: string; timeframe: string }, opts?: JobsOptions) {
  return marketScanQueue.add("scan", data, {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 20,
    removeOnFail: 50,
    ...(opts || {}),
  });
}

let workerInitialized = false;

export function ensureWorkers() {
  if (workerInitialized) return;

  new Worker(
    "market-scan",
    async (job) => {
      const { symbol, timeframe } = job.data as { symbol: string; timeframe: string };
      const result = await runDecisionEngine({ symbol, timeframe });
      if (!result.decision || result.blockedByRisk) return result;

      if (result.decision.action === "hold") return result;
      if (!["buy", "sell"].includes(result.decision.action)) return result;

      await executeOrder({
        symbol,
        side: result.decision.action === "buy" ? "buy" : "sell",
        quantity: 0.01,
        source: "ai",
        aiDecisionLogId: result.log.id,
        reasonSummary: result.decision.reason_summary,
        reasonRaw: result.decision.detailed_reason,
        reasonTags: ["trend", "volatility"],
      });

      return result;
    },
    { connection },
  ).on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "market-scan job failed");
  });

  workerInitialized = true;
}
