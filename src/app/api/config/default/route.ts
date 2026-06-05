import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { syncDefaultUserConfig } from "@/lib/config/default-user-config";
import { DEMO_USER_EMAIL } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ data: null });

  const config = await syncDefaultUserConfig(user.id);
  return NextResponse.json({ data: config });
}
