import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { executeOrder } from "@/lib/engine/execution-engine";
import { DEMO_USER_EMAIL } from "@/lib/utils";

const createTradeSchema = z.object({
  symbol: z.string(),
  side: z.enum(["buy", "sell"]),
  quantity: z.number().positive(),
  price: z.number().positive().optional(),
});

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ data: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 } });

  const page = Math.max(1, Number(requestUrl.searchParams.get("page") || 1));
  const pageSize = Math.min(100, Math.max(1, Number(requestUrl.searchParams.get("pageSize") || 50)));

  const where = { userId: user.id };
  const [orders, total] = await Promise.all([
    prisma.tradeOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        aiDecision: true,
        fills: true,
      },
    }),
    prisma.tradeOrder.count({ where }),
  ]);

  return NextResponse.json({
    data: orders,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
}

export async function POST(request: NextRequest) {
  const payload = createTradeSchema.parse(await request.json());

  const order = await executeOrder({
    symbol: payload.symbol,
    side: payload.side,
    quantity: payload.quantity,
    price: payload.price,
    source: "manual",
    reasonSummary: "手动下单",
    reasonRaw: "用户在实时交易页触发手动交易",
    reasonTags: ["manual"],
  });

  return NextResponse.json({ data: order });
}

export async function DELETE() {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ ok: true, deleted: 0 });

  const orders = await prisma.tradeOrder.findMany({
    where: { userId: user.id },
    select: { id: true },
  });
  const orderIds = orders.map((item) => item.id);
  await prisma.tradeFill.deleteMany({ where: { userId: user.id, tradeOrderId: { in: orderIds } } });
  const result = await prisma.tradeOrder.deleteMany({ where: { userId: user.id } });
  return NextResponse.json({ ok: true, deleted: result.count });
}
