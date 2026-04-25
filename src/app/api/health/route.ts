import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "autotrading-v2",
    timestamp: new Date().toISOString(),
  });
}
