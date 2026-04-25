import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

function deriveKey() {
  const raw = process.env.APP_ENCRYPTION_KEY || "local-dev-key";
  return createHash("sha256").update(raw).digest();
}

export function encryptText(plainText: string) {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptText(payload: string) {
  const [ivHex, tagHex, encryptedHex] = payload.split(":");
  if (!ivHex || !tagHex || !encryptedHex) return "";
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
