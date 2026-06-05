import { NextResponse } from "next/server";
import Papa from "papaparse";
import { prisma } from "@/lib/db";
import { DEMO_USER_EMAIL } from "@/lib/utils";

function asRecord(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function getSignal(payload: unknown) {
  return asRecord(asRecord(payload).signal);
}

export async function GET() {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return new NextResponse("no data", { status: 404 });

  const logs = await prisma.systemLog.findMany({
    where: { userId: user.id, category: "tradingview_webhook" },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  const csv = Papa.unparse(
    logs.map((log) => {
      const payload = asRecord(log.payload);
      const signal = getSignal(log.payload);
      const sizing = asRecord(payload.sizing);
      return {
        time: log.createdAt.toISOString(),
        level: log.level,
        message: log.message,
        kind: signal.kind ?? "",
        symbol: signal.symbol ?? "",
        instId: signal.instId ?? "",
        closePrice: signal.closePrice ?? "",
        rawMessage: signal.rawMessage ?? payload.rawBody ?? "",
        mode: payload.mode ?? "",
        env: payload.env ?? "",
        action: payload.action ?? "",
        side: payload.side ?? "",
        quantity: payload.quantity ?? sizing.quantity ?? "",
        leverage: payload.leverage ?? sizing.leverage ?? "",
        stopLossPct: payload.stopLossPct ?? sizing.stopLossPct ?? "",
        stopLossPrice: payload.stopLossPrice ?? sizing.stopLossPrice ?? "",
        orderId: payload.orderId ?? "",
        okxOrderId: payload.okxOrderId ?? "",
        status: payload.status ?? "",
        error: payload.error ?? "",
      };
    }),
  );

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=tradingview-logs-${Date.now()}.csv`,
    },
  });
}
