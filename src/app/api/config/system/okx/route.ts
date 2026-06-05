import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { EnvType } from "@prisma/client";
import { z } from "zod";
import { encryptText } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { syncDefaultUserConfig } from "@/lib/config/default-user-config";
import { DEMO_USER_EMAIL, maskSecret } from "@/lib/utils";

const okxSchema = z.object({
  label: z.string().min(1),
  envType: z.nativeEnum(EnvType),
  apiKey: z.string().optional().default(""),
  apiSecret: z.string().optional().default(""),
  passphrase: z.string().optional().default(""),
  readOnly: z.boolean(),
  enableAutoTrading: z.boolean(),
});

function isMaskedInput(value: string) {
  const text = value.trim();
  if (!text) return true;
  if (/^\*+$/.test(text)) return true;
  return text.includes("****");
}

export async function POST(request: NextRequest) {
  const raw = await request.json();
  const parsed = okxSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      {
        error: "OKX 配置参数校验失败",
        message: `${issue.path.join(".") || "payload"}: ${issue.message}`,
      },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const existingOkx = await prisma.exchangeAccount.findFirst({
    where: { userId: user.id, exchange: "okx", isDefault: true },
  });

  const okxApiKey = parsed.data.apiKey.trim();
  const okxApiSecret = parsed.data.apiSecret.trim();
  const okxPassphrase = parsed.data.passphrase.trim();
  const shouldUpdateOkxKey = !isMaskedInput(okxApiKey);
  const shouldUpdateOkxSecret = !isMaskedInput(okxApiSecret);
  const shouldUpdateOkxPassphrase = !isMaskedInput(okxPassphrase);

  const okxData = {
    label: parsed.data.label,
    envType: parsed.data.envType,
    readOnly: parsed.data.readOnly,
    enableAutoTrading: parsed.data.enableAutoTrading,
    ...(shouldUpdateOkxKey ? { apiKeyMasked: maskSecret(okxApiKey), encryptedApiKey: encryptText(okxApiKey) } : {}),
    ...(shouldUpdateOkxSecret ? { encryptedSecret: encryptText(okxApiSecret) } : {}),
    ...(shouldUpdateOkxPassphrase ? { encryptedPassphrase: encryptText(okxPassphrase) } : {}),
  };

  const saved = existingOkx
    ? await prisma.exchangeAccount.update({ where: { id: existingOkx.id }, data: okxData })
    : await prisma.exchangeAccount.create({
        data: {
          userId: user.id,
          exchange: "okx",
          isDefault: true,
          apiKeyMasked: shouldUpdateOkxKey ? maskSecret(okxApiKey) : "okx_****",
          encryptedApiKey: shouldUpdateOkxKey ? encryptText(okxApiKey) : "",
          encryptedSecret: shouldUpdateOkxSecret ? encryptText(okxApiSecret) : "",
          encryptedPassphrase: shouldUpdateOkxPassphrase ? encryptText(okxPassphrase) : "",
          ...okxData,
        },
      });

  await syncDefaultUserConfig(user.id);
  revalidatePath("/settings");
  revalidatePath("/dashboard");
  revalidatePath("/api/dashboard/overview");

  return NextResponse.json({ id: saved.id });
}
