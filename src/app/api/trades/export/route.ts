import { NextResponse } from "next/server";
import Papa from "papaparse";
import { prisma } from "@/lib/db";
import { DEMO_USER_EMAIL } from "@/lib/utils";

export async function GET() {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return new NextResponse("no data", { status: 404 });

  const orders = await prisma.tradeOrder.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });

  const csv = Papa.unparse(
    orders.map((order) => ({
      time: order.createdAt.toISOString(),
      symbol: order.symbol,
      action: order.action,
      side: order.side,
      price: order.price,
      quantity: order.quantity,
      orderType: order.orderType,
      status: order.status,
      fee: order.fee,
      slippage: order.estimatedSlippage,
      source: order.triggerSource,
      summary: order.aiDecisionSummary,
    })),
  );

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=trade-logs-${Date.now()}.csv`,
    },
  });
}
