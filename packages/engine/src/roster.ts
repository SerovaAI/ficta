import { createHmac } from "node:crypto";
import { InvalidEngineConfigError } from "./config.js";
import type { RegistrySourcePlugin } from "./plugins/types.js";
import {
  protectionRecordSurfaces,
  type RegisteredEntityForm,
  type RegisteredEntityProtection,
  type StructuredRegistrySourceCapabilities,
} from "./protection.js";
import { canonicalEncode } from "./surrogate.js";

// The library roster: known people and organisations an embedding application supplies to
// `createEngine`. The engine owns the mechanism (validation, exact matching before detection, linked
// tokens, the leak check, a fingerprint); the application owns the data (where entries come from,
// storage, refresh, merge policy). The roster is never written to a vault store: only the mappings
// minted from it in keyed scopes are, so their tokens keep restoring after an entry goes away.

/** One known person or organisation. */
export interface RosterEntry {
  /**
   * The application's stable identifier for this entity. Linked tokens derive from it (with the
   * surrogate key and scope key), never from roster order, so keep it stable across restarts.
   */
  readonly id: string;
  readonly type: "person" | "organization";
  /** The entity's full name, matched case-insensitively anywhere in the text. */
  readonly canonical: string;
  /** Other exact surfaces (short names, nicknames, email addresses), matched at word boundaries. */
  readonly forms?: readonly string[];
}

/** Where a roster comes from. The engine calls `load()` once, in {@link createEngine}. */
export interface RosterSource {
  load(): Promise<readonly RosterEntry[]> | readonly RosterEntry[];
}

/** A validated roster, ready for the engine. Holds values: keep it in memory only. */
export interface LoadedRoster {
  readonly records: readonly RegisteredEntityProtection[];
  /** Entries accepted. */
  readonly size: number;
  /** Distinct forms dropped because more than one entry claimed them. */
  readonly ambiguousForms: number;
  /** Keyed, order-independent hash of the normalized roster; reveals no names. */
  readonly fingerprint: string;
}

/** Prefix keeping roster entity ids apart from every other registry or detector entity id. */
const ROSTER_ENTITY_PREFIX = "roster:";
const MIN_SURFACE_LENGTH = 2;
const MAX_ENTRIES = 100_000;

interface NormalizedEntry {
  readonly id: string;
  readonly type: "person" | "organization";
  readonly canonical: string;
  readonly forms: readonly string[];
}

/** Resolve the `roster` option (entries or a source), validate it, and build its records. */
export async function loadRoster(
  input: RosterSource | readonly RosterEntry[] | undefined,
  surrogateKey: string,
): Promise<LoadedRoster> {
  let entries: unknown;
  if (input === undefined) entries = [];
  else if (Array.isArray(input)) entries = input;
  else if (input !== null && typeof input === "object" && typeof (input as RosterSource).load === "function") {
    entries = await (input as RosterSource).load();
  } else {
    throw new InvalidEngineConfigError("roster: expected an array of entries or an object with load()");
  }
  return buildRoster(entries, surrogateKey);
}

/**
 * Validate entries and map them onto registered-entity records. Messages name entry indexes only,
 * never an id, a name or a form.
 */
export function buildRoster(entries: unknown, surrogateKey: string): LoadedRoster {
  if (!Array.isArray(entries)) throw new InvalidEngineConfigError("roster: expected an array of entries");
  if (entries.length > MAX_ENTRIES) {
    throw new InvalidEngineConfigError(`roster: at most ${MAX_ENTRIES} entries are supported`);
  }
  const normalized = entries.map((entry, index) => normalizeEntry(entry, index));

  const ids = new Map<string, number>();
  normalized.forEach((entry, index) => {
    const first = ids.get(entry.id);
    if (first !== undefined) throw new InvalidEngineConfigError(`roster[${index}].id: duplicates roster[${first}].id`);
    ids.set(entry.id, index);
  });

  // Who claims each surface (case- and whitespace-insensitively), and whether as a canonical name.
  const claims = new Map<string, { canonical: number[]; form: Set<number> }>();
  const claim = (surface: string) => {
    const key = surfaceKey(surface);
    let owners = claims.get(key);
    if (!owners) claims.set(key, (owners = { canonical: [], form: new Set() }));
    return owners;
  };
  normalized.forEach((entry, index) => {
    claim(entry.canonical).canonical.push(index);
    for (const form of entry.forms) claim(form).form.add(index);
  });

  const ambiguous = new Set<string>();
  for (const [key, owners] of claims) {
    const claimants = new Set([...owners.canonical, ...owners.form]);
    if (claimants.size < 2) continue;
    if (owners.canonical.length > 0) {
      // A canonical name has to identify one entry; which one is the application's merge decision.
      const owner = Math.min(...owners.canonical);
      const other = Math.min(...[...claimants].filter((index) => index !== owner));
      throw new InvalidEngineConfigError(
        `roster[${other}]: shares a canonical name or form with roster[${owner}]'s canonical name; merge or disambiguate them`,
      );
    }
    ambiguous.add(key);
  }

  const records = normalized.map((entry) => toRecord(entry, ambiguous));
  return {
    records,
    size: records.length,
    ambiguousForms: ambiguous.size,
    fingerprint: rosterFingerprint(normalized, surrogateKey),
  };
}

/** A registry source for the engine's existing structured-registry path. */
export function rosterRegistrySource(
  roster: LoadedRoster,
): RegistrySourcePlugin & StructuredRegistrySourceCapabilities {
  const records = roster.records;
  return {
    kind: "registry-source",
    name: "roster",
    config: { bindings: [], sections: [], envDefaults: {} },
    setup: { registrySources: () => [] },
    discover: () => [],
    loadValues: () => records.flatMap(protectionRecordSurfaces),
    loadProtectionRecords: () => records,
    fatalLoadErrors: true,
  };
}

function normalizeEntry(raw: unknown, index: number): NormalizedEntry {
  const where = `roster[${index}]`;
  if (raw === null || typeof raw !== "object") throw new InvalidEngineConfigError(`${where}: expected an object`);
  const entry = raw as Partial<Record<keyof RosterEntry, unknown>>;
  if (typeof entry.id !== "string" || entry.id.trim().length === 0) {
    throw new InvalidEngineConfigError(`${where}.id: expected a non-empty string`);
  }
  if (entry.type !== "person" && entry.type !== "organization") {
    throw new InvalidEngineConfigError(`${where}.type: expected "person" or "organization"`);
  }
  const canonical = surface(entry.canonical, `${where}.canonical`);
  if (entry.forms !== undefined && !Array.isArray(entry.forms)) {
    throw new InvalidEngineConfigError(`${where}.forms: expected an array of strings`);
  }
  const forms = new Set<string>();
  for (const [formIndex, form] of ((entry.forms as unknown[] | undefined) ?? []).entries()) {
    const value = surface(form, `${where}.forms[${formIndex}]`);
    // The canonical name already matches every casing of itself.
    if (surfaceKey(value) !== surfaceKey(canonical)) forms.add(value);
  }
  return { id: entry.id, type: entry.type, canonical, forms: [...forms].sort() };
}

function surface(value: unknown, where: string): string {
  if (typeof value !== "string") throw new InvalidEngineConfigError(`${where}: expected a string`);
  const trimmed = value.trim();
  if (trimmed.length < MIN_SURFACE_LENGTH) {
    throw new InvalidEngineConfigError(`${where}: expected at least ${MIN_SURFACE_LENGTH} non-space characters`);
  }
  if (trimmed.includes("FICTA_")) throw new InvalidEngineConfigError(`${where}: must not contain a token prefix`);
  return trimmed;
}

/** How surfaces compare for ambiguity: matching is case-insensitive and whitespace-flexible. */
function surfaceKey(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").toLowerCase();
}

function toRecord(entry: NormalizedEntry, ambiguous: ReadonlySet<string>): RegisteredEntityProtection {
  const entityId = `${ROSTER_ENTITY_PREFIX}${entry.id}`;
  const forms: RegisteredEntityForm[] = entry.forms
    .filter((form) => !ambiguous.has(surfaceKey(form)))
    .map((value, index) => ({ formId: `${entityId}:form:${index}`, value, kind: "alias", boundary: "token" }));
  return {
    protectionKind: "entity",
    entityId,
    entityType: entry.type,
    canonical: { formId: `${entityId}:canonical`, value: entry.canonical, kind: "full_name" },
    forms,
    provenance: "registry",
    meta: {
      name: entry.type,
      value: entry.canonical,
      source: "roster",
      plugin: "roster",
      kind: "pii",
      confidence: "exact",
    },
  };
}

/**
 * HMAC over the sorted, normalized entries under a key derived from the surrogate key: equal for
 * the same roster in any order, different when any entry changes, and meaningless without the key.
 */
function rosterFingerprint(entries: readonly NormalizedEntry[], surrogateKey: string): string {
  const key = createHmac("sha256", surrogateKey).update("ficta.roster-fingerprint.v1").digest();
  const encoded = entries
    .map((entry) => Buffer.from(canonicalEncode(entry.id, entry.type, entry.canonical, ...entry.forms)))
    .sort(Buffer.compare);
  const mac = createHmac("sha256", key);
  for (const part of encoded) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(part.length);
    mac.update(length).update(part);
  }
  return mac.digest("hex");
}
