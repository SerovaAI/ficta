import { createHash, randomUUID } from "node:crypto";
import {
  FICTA_MANAGED_REGISTRY_SCHEMA,
  isManagedRegistryFile,
  type ManagedRegistryEntry,
  type ManagedRegistryFile,
} from "@serovaai/ficta-protocol";
import { normalizeProtectedRegistryValue, type ProtectedRegistryEntry } from "./types";

/** Render approved persisted entries into the proxy-owned managed-registry file contract. */
export function renderManagedRegistryFile(entries: ProtectedRegistryEntry[]): {
  body: string;
  revision: string;
  values: number;
} {
  const revision = randomUUID();
  const registryEntries: ManagedRegistryEntry[] = [];
  let values = 0;
  entries.forEach((entry) => {
    if (entry.protectionKind === "entity") {
      const canonical = normalizeProtectedRegistryValue(entry.value);
      const forms = entry.forms.filter((form) => normalizeProtectedRegistryValue(form.value) !== canonical);
      registryEntries.push({
        id: entry.id,
        protectionKind: "entity",
        entityType: entry.entityType,
        canonicalValue: entry.value,
        forms,
      });
      values += 1 + forms.length;
      return;
    }
    registryEntries.push({
      id: entry.id,
      protectionKind: "literal",
      value: entry.value,
      semanticType: entry.type,
    });
    values++;
    for (const form of entry.forms.filter(
      (form) => normalizeProtectedRegistryValue(form.value) !== normalizeProtectedRegistryValue(entry.value),
    )) {
      registryEntries.push({
        id: literalFormId(entry.id, form.value),
        protectionKind: "literal",
        value: form.value,
        semanticType: entry.type,
      });
      values++;
    }
  });
  const file: ManagedRegistryFile = {
    schema: FICTA_MANAGED_REGISTRY_SCHEMA,
    revision,
    generatedBy: "ficta-gateway",
    generatedAt: new Date().toISOString(),
    entries: registryEntries,
  };
  if (!isManagedRegistryFile(file)) {
    throw new Error("approved registry contains duplicate ids, conflicting entity forms, or invalid registry data");
  }
  return {
    body: `${JSON.stringify(file, null, 2)}\n`,
    revision,
    values,
  };
}

function literalFormId(entryId: string, value: string): string {
  const digest = createHash("sha256").update(normalizeProtectedRegistryValue(value)).digest("hex").slice(0, 16);
  return `${entryId}:form:${digest}`;
}
