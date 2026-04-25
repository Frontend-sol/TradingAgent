import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { DEMO_USER_EMAIL } from "@/lib/utils";

export async function GET(request: NextRequest) {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ data: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 } });

  const requestUrl = new URL(request.url);
  const page = Math.max(1, Number(requestUrl.searchParams.get("page") || 1));
  const pageSize = Math.min(100, Math.max(1, Number(requestUrl.searchParams.get("pageSize") || 50)));

  const where = { userId: user.id };
  const [logs, total] = await Promise.all([
    prisma.aiDecisionLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        tradeOrders: true,
      },
    }),
    prisma.aiDecisionLog.count({ where }),
  ]);

  return NextResponse.json({
    data: logs,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
}

export async function DELETE() {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ ok: true, deleted: 0 });

  await prisma.tradeOrder.updateMany({
    where: { userId: user.id, aiDecisionLogId: { not: null } },
    data: { aiDecisionLogId: null },
  });
  const result = await prisma.aiDecisionLog.deleteMany({ where: { userId: user.id } });
  return NextResponse.json({ ok: true, deleted: result.count });
}
