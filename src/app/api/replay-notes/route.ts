import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { DEMO_USER_EMAIL } from "@/lib/utils";

const schema = z.object({
  tradeOrderId: z.string().min(1),
  content: z.string().min(1),
});

export async function GET(request: NextRequest) {
  const tradeOrderId = request.nextUrl.searchParams.get("tradeOrderId");
  if (!tradeOrderId) return NextResponse.json({ data: [] });

  const notes = await prisma.replayNote.findMany({
    where: { tradeOrderId },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ data: notes });
}

export async function POST(request: NextRequest) {
  const payload = schema.parse(await request.json());
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const note = await prisma.replayNote.create({
    data: {
      userId: user.id,
      tradeOrderId: payload.tradeOrderId,
      content: payload.content,
    },
  });

  return NextResponse.json({ data: note });
}
