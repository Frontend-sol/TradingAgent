import { NextRequest, NextResponse } from "next/server";
import {
  executeTradingViewWebhook,
  parseTradingViewSignal,
  recordTradingViewWebhookError,
} from "@/lib/trade/tradingview-webhook";

export async function POST(request: NextRequest) {
  const expectedToken = process.env.TRADINGVIEW_WEBHOOK_SECRET;
  const token = request.nextUrl.searchParams.get("token") || request.headers.get("x-tradingview-token");
  if (!expectedToken) {
    return NextResponse.json({ ok: false, error: "TRADINGVIEW_WEBHOOK_SECRET is not configured" }, { status: 500 });
  }
  if (token !== expectedToken) {
    return NextResponse.json({ ok: false, error: "Unauthorized TradingView webhook" }, { status: 401 });
  }

  const rawBody = await request.text();
  try {
    const result = await executeTradingViewWebhook(rawBody);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    await recordTradingViewWebhookError(rawBody, error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        rawBody,
      },
      { status: 400 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "/api/webhooks/tradingview",
    legacyEndpoint: "/api/trade/tradingview/webhook",
    supportedMessages: [
      "【开多入场】 {{ticker}} @ {{close}} | 动能与结构确认",
      "【开空入场】 {{ticker}} @ {{close}} | 动能与结构确认",
      "【开空入场】Type:ETH @ {{close}}",
      "【顺势加多】 {{ticker}} @ {{close}} | 趋势延续",
      "【顺势加空】 {{ticker}} @ {{close}} | 趋势延续",
      "【精准止盈】 {{ticker}} 利润落袋！",
      "【触发止损】 {{ticker}} 跌破生命线，注意防守！",
    ],
    sampleParsed: parseTradingViewSignal("【开空入场】Type:ETH @ 65000").signal,
  });
}
