import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

function parsePromptType(storedName: string): "system" | "user" {
  if (storedName.startsWith("SYS::")) return "system";
  if (storedName.startsWith("USR::")) return "user";
  return "user";
}

function parsePromptName(storedName: string) {
  return storedName.replace(/^SYS::|^USR::/i, "").trim();
}

function safeJson<T>(value: T) {
  if (value == null) return Prisma.JsonNull;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function syncDefaultUserConfig(userId: string) {
  const [llm, okx, strategy, risk, promptTemplates] = await Promise.all([
    prisma.llmProviderConfig.findFirst({ where: { userId, isDefault: true }, orderBy: { updatedAt: "desc" } }),
    prisma.exchangeAccount.findFirst({ where: { userId, exchange: "okx", isDefault: true }, orderBy: { updatedAt: "desc" } }),
    prisma.strategyConfig.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" } }),
    prisma.riskConfig.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" } }),
    prisma.tradingPromptConfig.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
  ]);

  const activeSystemPrompt = llm?.systemPrompt || "";
  const activeUserPrompt = llm?.tradingPrompt || strategy?.llmPromptTemplate || "";
  const normalizedPromptTemplates = promptTemplates.map((item) => ({
    id: item.id,
    name: parsePromptName(item.name),
    promptType: parsePromptType(item.name),
    content: item.content,
    isDefault: item.isDefault,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));

  return prisma.userDefaultConfig.upsert({
    where: { userId },
    update: {
      activeSystemPrompt,
      activeUserPrompt,
      llmConfig: safeJson(llm),
      okxConfig: safeJson(okx),
      strategyConfig: safeJson(strategy),
      riskConfig: risk ? safeJson(risk) : Prisma.JsonNull,
      promptTemplates: safeJson(normalizedPromptTemplates),
    },
    create: {
      userId,
      activeSystemPrompt,
      activeUserPrompt,
      llmConfig: safeJson(llm),
      okxConfig: safeJson(okx),
      strategyConfig: safeJson(strategy),
      riskConfig: risk ? safeJson(risk) : Prisma.JsonNull,
      promptTemplates: safeJson(normalizedPromptTemplates),
    },
  });
}
