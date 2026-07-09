import { createServerFn } from "@tanstack/react-start";
import { requireAdminScope } from "@/lib/auth/guards.server";
import type { Provider } from "@/lib/models";
import { completeProviderKeySummaries, encryptProviderKey, isProvider } from "@/lib/provider-keys.server";
import { getStorage } from "./storage.server";
import type { ProviderKeySummary } from "./types";

const PROVIDER_KEY_MAX = 4096;

function asObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null) throw new Error("invalid provider key payload");
  return input as Record<string, unknown>;
}

function validateProviderKeySave(input: unknown): { provider: Provider; apiKey: string } {
  const i = asObject(input);
  if (!isProvider(i.provider)) throw new Error("invalid provider");
  if (typeof i.apiKey !== "string") throw new Error("invalid provider key");
  const apiKey = i.apiKey.trim();
  if (!apiKey) throw new Error("provider key is required");
  if (apiKey.length > PROVIDER_KEY_MAX) throw new Error("provider key is too long");
  return { provider: i.provider, apiKey };
}

function validateProviderKeyDelete(input: unknown): { provider: Provider } {
  const i = asObject(input);
  if (!isProvider(i.provider)) throw new Error("invalid provider");
  return { provider: i.provider };
}

export const fetchProviderKeySummaries = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProviderKeySummary[]> => {
    const { orgId } = await requireAdminScope();
    const summaries = await (await getStorage()).listProviderKeySummaries(orgId);
    return completeProviderKeySummaries(summaries);
  },
);

export const saveProviderKey = createServerFn({ method: "POST" })
  .validator(validateProviderKeySave)
  .handler(async ({ data }): Promise<ProviderKeySummary[]> => {
    const { orgId } = await requireAdminScope();
    const encrypted = encryptProviderKey(data.provider, data.apiKey);
    const store = await getStorage();
    await store.upsertProviderKey(orgId, encrypted);
    return completeProviderKeySummaries(await store.listProviderKeySummaries(orgId));
  });

export const deleteProviderKey = createServerFn({ method: "POST" })
  .validator(validateProviderKeyDelete)
  .handler(async ({ data }): Promise<ProviderKeySummary[]> => {
    const { orgId } = await requireAdminScope();
    const store = await getStorage();
    await store.deleteProviderKey(orgId, data.provider);
    return completeProviderKeySummaries(await store.listProviderKeySummaries(orgId));
  });
