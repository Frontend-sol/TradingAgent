import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { DEMO_USER_EMAIL } from "@/lib/utils";
import { syncDefaultUserConfig } from "@/lib/config/default-user-config";

const riskSchema = z.object({
  maxPositionValue: z.number().min(0),
  maxSingleOrderValue: z.number().min(0),
  maxDailyLoss: z.number().min(0),
  maxDrawdownPct: z.number().min(0).max(100),
  maxConsecutiveLosses: z.number().int().min(1).max(100),
  stopOnModelError: z.boolean(),
  stopOnApiError: z.boolean(),
  highVolatilityPause: z.boolean(),
  volatilityThreshold: z.number().min(0),
  whitelistSymbols: z.array(z.string()),
  blacklistSymbols: z.array(z.string()),
  killSwitchEnabled: z.boolean(),
});

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ data: null });

  const risk = await prisma.riskConfig.findFirst({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json({ data: risk });
}

export async function POST(request: NextRequest) {
  const parsed = riskSchema.safeParse(await request.json());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      {
        error: "风控参数校验失败",
        message: `${issue.path.join(".") || "payload"}: ${issue.message}`,
      },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const payload = parsed.data;
  const existing = await prisma.riskConfig.findFirst({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
  });

  const saved = existing
    ? await prisma.riskConfig.update({
        where: { id: existing.id },
        data: payload,
      })
    : await prisma.riskConfig.create({
        data: {
          userId: user.id,
          ...payload,
        },
      });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "update_risk_config",
      target: "risk_config",
      before: existing || {},
      after: saved,
    },
  });

  await syncDefaultUserConfig(user.id);

  return NextResponse.json({ id: saved.id });
}
