process.env.FICTA_GATEWAY_DATA_DIR = "memory://";
process.env.DATABASE_URL = "";

import { beforeEach, describe, expect, it } from "vitest";
import {
  decryptProviderKey,
  encryptProviderKey,
  MissingKeyError,
  ProviderKeyDecryptionError,
  resolveProviderApiKey,
} from "@/lib/provider-keys.server";
import { getStorage } from "@/lib/storage/storage.server";

const SECRET = "test-encryption-secret";

beforeEach(() => {
  process.env.FICTA_GATEWAY_KEY_ENCRYPTION_SECRET = SECRET;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("provider key encryption", () => {
  it("round-trips provider keys without storing plaintext", () => {
    const plaintext = "sk-test-secret-value";
    const encrypted = encryptProviderKey("openai", plaintext);

    expect(encrypted.ciphertext).not.toContain(plaintext);
    expect(encrypted.iv).not.toContain(plaintext);
    expect(encrypted.tag).not.toContain(plaintext);
    expect(encrypted.keyHint).toBe("...alue");
    expect(decryptProviderKey(encrypted)).toBe(plaintext);
  });

  it("rejects ciphertext encrypted with a different secret", () => {
    const encrypted = encryptProviderKey("anthropic", "anthropic-secret");
    process.env.FICTA_GATEWAY_KEY_ENCRYPTION_SECRET = "different-secret";

    expect(() => decryptProviderKey(encrypted)).toThrow(ProviderKeyDecryptionError);
  });
});

describe("provider key resolution", () => {
  it("uses a saved workspace key before the env fallback", async () => {
    const store = await getStorage();
    await store.upsertProviderKey("org-byok", encryptProviderKey("openai", "saved-openai-key"));
    process.env.OPENAI_API_KEY = "env-openai-key";

    await expect(resolveProviderApiKey("org-byok", "openai")).resolves.toBe("saved-openai-key");
  });

  it("uses the env fallback when no workspace key exists", async () => {
    process.env.ANTHROPIC_API_KEY = "env-anthropic-key";

    await expect(resolveProviderApiKey("org-env", "anthropic")).resolves.toBe("env-anthropic-key");
  });

  it("reports a missing key when neither workspace nor env has one", async () => {
    await expect(resolveProviderApiKey("org-missing", "openai")).rejects.toThrow(MissingKeyError);
  });

  it("fails hard on an undecryptable saved key instead of falling back to env", async () => {
    const store = await getStorage();
    await store.upsertProviderKey("org-bad-secret", encryptProviderKey("openai", "saved-openai-key"));
    process.env.OPENAI_API_KEY = "env-openai-key";
    process.env.FICTA_GATEWAY_KEY_ENCRYPTION_SECRET = "wrong-secret";

    await expect(resolveProviderApiKey("org-bad-secret", "openai")).rejects.toThrow(ProviderKeyDecryptionError);
  });
});
