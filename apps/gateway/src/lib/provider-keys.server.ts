import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { PROVIDERS, type Provider } from "@/lib/models";
import { getStorage } from "@/lib/storage/storage.server";
import type { EncryptedProviderKey, ProviderKeySummary } from "@/lib/storage/types";

const ENCRYPTION_SECRET_ENV = "FICTA_GATEWAY_KEY_ENCRYPTION_SECRET";
const KEY_SALT = "ficta-gateway-provider-keys-v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

const ENV_KEY_BY_PROVIDER: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/** The server-side API key for the chosen provider is not configured. */
export class MissingKeyError extends Error {
  constructor(name: string) {
    super(`${name} is not set on the ficta server; add it to apps/gateway/.env or save a workspace provider key`);
    this.name = "MissingKeyError";
  }
}

/** A saved provider key exists, but the process cannot decrypt it with the current env secret. */
export class ProviderKeyDecryptionError extends Error {
  constructor(provider: Provider) {
    super(`saved ${provider} provider key could not be decrypted; check ${ENCRYPTION_SECRET_ENV}`);
    this.name = "ProviderKeyDecryptionError";
  }
}

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && PROVIDERS.includes(value as Provider);
}

export function encryptProviderKey(provider: Provider, apiKey: string): EncryptedProviderKey {
  const plaintext = apiKey.trim();
  if (!plaintext) throw new Error("provider key is required");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    provider,
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    keyHint: keyHint(plaintext),
  };
}

export function decryptProviderKey(key: EncryptedProviderKey): string {
  try {
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(key.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(key.tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(key.ciphertext, "base64url")), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw new ProviderKeyDecryptionError(key.provider);
  }
}

export async function resolveProviderApiKey(orgId: string, provider: Provider): Promise<string> {
  const saved = await (await getStorage()).getProviderKey(orgId, provider);
  if (saved) return decryptProviderKey(saved);

  const envName = ENV_KEY_BY_PROVIDER[provider];
  const value = process.env[envName]?.trim();
  if (!value) throw new MissingKeyError(envName);
  return value;
}

export function completeProviderKeySummaries(summaries: ProviderKeySummary[]): ProviderKeySummary[] {
  const byProvider = new Map(summaries.map((summary) => [summary.provider, summary]));
  return PROVIDERS.map(
    (provider): ProviderKeySummary =>
      byProvider.get(provider) ?? {
        provider,
        configured: false,
        keyHint: "",
        updatedAt: "",
      },
  );
}

function encryptionKey(): Buffer {
  const secret = process.env[ENCRYPTION_SECRET_ENV]?.trim();
  if (!secret) throw new Error(`${ENCRYPTION_SECRET_ENV} is not set; set it before saving provider keys`);
  return scryptSync(secret, KEY_SALT, 32);
}

function keyHint(apiKey: string): string {
  const compact = apiKey.replace(/\s+/g, "");
  return compact.length > 4 ? `...${compact.slice(-4)}` : "configured";
}
