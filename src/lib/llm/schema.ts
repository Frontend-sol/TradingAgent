import { z } from "zod";

export const aiDecisionSchema = z.object({
  action: z.enum([
    "buy",
    "sell",
    "hold",
    "close_long",
    "close_short",
    "open_long",
    "open_short",
  ]),
  confidence: z.number().min(0).max(100),
  reason_summary: z.string().min(1),
  detailed_reason: z.string().min(1),
  risk_level: z.enum(["low", "medium", "high"]),
  suggested_leverage: z.number().nonnegative(),
  suggested_position_size_pct: z.number().min(0).max(100),
  stop_loss: z.number(),
  take_profit: z.number(),
  invalidate_condition: z.string().min(1),
  signals: z.object({
    trend: z.string(),
    momentum: z.string(),
    volume: z.string(),
    volatility: z.string(),
    support_resistance: z.string(),
  }),
});

export type AiDecision = z.infer<typeof aiDecisionSchema>;
