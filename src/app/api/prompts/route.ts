import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { DEMO_USER_EMAIL } from "@/lib/utils";
import { syncDefaultUserConfig } from "@/lib/config/default-user-config";

const promptTypeEnum = z.enum(["system", "user"]);

const schema = z.object({
  name: z.string().min(1),
  content: z.string().min(1),
  promptType: promptTypeEnum,
  isDefault: z.boolean().default(false),
});

const updateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  content: z.string().min(1),
  promptType: promptTypeEnum,
  isDefault: z.boolean().default(false),
});

function buildStoredName(name: string, promptType: "system" | "user") {
  const prefix = promptType === "system" ? "SYS::" : "USR::";
  const pureName = name.replace(/^SYS::|^USR::/i, "").trim();
  return `${prefix}${pureName}`;
}

function parsePromptType(storedName: string): "system" | "user" {
  if (storedName.startsWith("SYS::")) return "system";
  if (storedName.startsWith("USR::")) return "user";
  return "user";
}

function parsePromptName(storedName: string) {
  return storedName.replace(/^SYS::|^USR::/i, "").trim();
}

export async function GET(request: NextRequest) {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ data: [] });

  const promptType = promptTypeEnum.safeParse(new URL(request.url).searchParams.get("promptType"));

  const templates = await prisma.tradingPromptConfig.findMany({
    where: { userId: user.id },
    orderBy: [{ createdAt: "asc" }],
  });

  const normalized = templates.map((item) => ({
    id: item.id,
    userId: item.userId,
    name: parsePromptName(item.name),
    content: item.content,
    isDefault: item.isDefault,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    promptType: parsePromptType(item.name),
  }));

  if (promptType.success) {
    return NextResponse.json({ data: normalized.filter((item) => item.promptType === promptType.data) });
  }

  return NextResponse.json({ data: normalized });
}

export async function POST(request: NextRequest) {
  const payload = schema.parse(await request.json());
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const created = await prisma.tradingPromptConfig.create({
    data: {
      userId: user.id,
      name: buildStoredName(payload.name, payload.promptType),
      content: payload.content,
      isDefault: payload.isDefault,
    },
  });

  await syncDefaultUserConfig(user.id);

  return NextResponse.json({
    data: {
      ...created,
      name: parsePromptName(created.name),
      promptType: parsePromptType(created.name),
    },
  });
}

export async function PUT(request: NextRequest) {
  const payload = updateSchema.parse(await request.json());
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const existing = await prisma.tradingPromptConfig.findFirst({ where: { id: payload.id, userId: user.id } });
  if (!existing) return NextResponse.json({ error: "Prompt not found" }, { status: 404 });

  const updated = await prisma.tradingPromptConfig.update({
    where: { id: existing.id },
    data: {
      name: buildStoredName(payload.name, payload.promptType),
      content: payload.content,
      isDefault: payload.isDefault,
    },
  });

  await syncDefaultUserConfig(user.id);

  return NextResponse.json({
    data: {
      ...updated,
      name: parsePromptName(updated.name),
      promptType: parsePromptType(updated.name),
    },
  });
}

export async function DELETE(request: NextRequest) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const existing = await prisma.tradingPromptConfig.findFirst({ where: { id, userId: user.id } });
  if (!existing) return NextResponse.json({ error: "Prompt not found" }, { status: 404 });

  await prisma.tradingPromptConfig.delete({ where: { id: existing.id } });
  await syncDefaultUserConfig(user.id);
  return NextResponse.json({ ok: true });
}
