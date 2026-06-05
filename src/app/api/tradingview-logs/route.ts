import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { DEMO_USER_EMAIL } from "@/lib/utils";

export async function GET(request: NextRequest) {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) {
    return NextResponse.json({ data: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 } });
  }

  const requestUrl = new URL(request.url);
  const page = Math.max(1, Number(requestUrl.searchParams.get("page") || 1));
  const pageSize = Math.min(100, Math.max(1, Number(requestUrl.searchParams.get("pageSize") || 50)));

  const where = { userId: user.id, category: "tradingview_webhook" };
  const [logs, total] = await Promise.all([
    prisma.systemLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.systemLog.count({ where }),
  ]);

  return NextResponse.json({
    data: logs,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
}

export async function DELETE() {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ ok: true, deleted: 0 });

  const result = await prisma.systemLog.deleteMany({
    where: { userId: user.id, category: "tradingview_webhook" },
  });
  return NextResponse.json({ ok: true, deleted: result.count });
}
