import type {
  EditableProxyConfigKey,
  EditableProxyConfigValues,
  PiiBackendName,
  ProxyConfigEditState,
  ProxyConfigPatchResponse,
} from "@serovaai/ficta-protocol";
import { normalizePiiBackends, normalizeRestoreIntoToolsPolicy } from "@serovaai/ficta-protocol";
import type { Config } from "./config.js";
import { configPosture } from "./config-posture.js";
import {
  InvalidEngineConfigError,
  normalizeCategory,
  parseBoolean,
  resolveEngineConfig,
  restoreIntoToolsPolicy,
} from "@serovaai/ficta-engine";
import { configPath, readUserConfig, wasLoadedFromUserConfig, writeUserConfig } from "./user-config.js";

const FIELD_ENV: Record<EditableProxyConfigKey, string> = {
  failClosed: "FICTA_FAIL_CLOSED",
  piiEnabled: "FICTA_PII_ENABLED",
  piiBackends: "FICTA_PII_BACKENDS",
  piiFailClosed: "FICTA_PII_FAIL_CLOSED",
  piiPresidioUrl: "FICTA_PII_PRESIDIO_URL",
  piiOpenmedUrl: "FICTA_PII_OPENMED_URL",
  secretShapesEnabled: "FICTA_SECRET_SHAPES_ENABLED",
  surrogateStyle: "FICTA_SURROGATE_STYLE",
  restoreIntoTools: "FICTA_RESTORE_INTO_TOOLS",
  allowCustomUpstream: "FICTA_ALLOW_CUSTOM_UPSTREAM",
  destroyCategories: "FICTA_DESTROY_CATEGORIES",
};

const LEGACY_BACKEND_ENV = "FICTA_PII_BACKEND";
/** TOML-only destroy labels; an edit drops labels for categories it stops destroying. */
const DESTROY_LABELS_ENV = "FICTA_DESTROY_LABELS";
/** Reported (never accepted) value of a destroy-everything policy configured in TOML/env. */
const DESTROY_ALL = "*";
const DESTROY_ALL_LOCK =
  'dispositions.destroy.categories is "*" (every detected category) in config.toml; edit it there and restart.';

const EDITABLE_KEYS = new Set<EditableProxyConfigKey>(Object.keys(FIELD_ENV) as EditableProxyConfigKey[]);

export function proxyConfigLockedFields(): Partial<Record<EditableProxyConfigKey, string>> {
  return lockedFields();
}

export function proxyConfigEditState(
  cfg: Config,
  startupLocked: Partial<Record<EditableProxyConfigKey, string>> = lockedFields(),
): ProxyConfigEditState {
  const path = configPath();
  const effective = effectiveEditableValues(cfg);
  if (!path) return { disabled: true, restartRequired: false, values: effective, locked: {} };

  const fileValues = readUserConfig(path);
  const locked = withDestroyAllLock(startupLocked, fileValues, effective.destroyCategories);
  const values: EditableProxyConfigValues = {
    failClosed: boolValue("failClosed", fileValues, effective.failClosed, locked),
    piiEnabled: boolValue("piiEnabled", fileValues, effective.piiEnabled, locked),
    piiBackends: piiBackendsValue(fileValues, effective.piiBackends, locked),
    piiFailClosed: boolValue("piiFailClosed", fileValues, effective.piiFailClosed, locked),
    piiPresidioUrl: stringValue("piiPresidioUrl", fileValues, effective.piiPresidioUrl, locked),
    piiOpenmedUrl: stringValue("piiOpenmedUrl", fileValues, effective.piiOpenmedUrl, locked),
    secretShapesEnabled: boolValue("secretShapesEnabled", fileValues, effective.secretShapesEnabled, locked),
    surrogateStyle: surrogateStyleValue(fileValues, effective.surrogateStyle, locked),
    restoreIntoTools: restoreIntoToolsValue(fileValues, effective.restoreIntoTools, locked),
    allowCustomUpstream: boolValue("allowCustomUpstream", fileValues, effective.allowCustomUpstream, locked),
    destroyCategories: destroyCategoriesValue(fileValues, effective.destroyCategories, startupLocked),
  };

  return {
    path,
    disabled: false,
    restartRequired: !editableValuesEqual(values, effective),
    values,
    locked,
  };
}

export function applyProxyConfigPatch(
  cfg: Config,
  patch: unknown,
  startupLocked: Partial<Record<EditableProxyConfigKey, string>> = lockedFields(),
): ProxyConfigPatchResponse {
  const path = configPath();
  if (!path) {
    return {
      ok: false,
      service: "ficta",
      status: "disabled",
      message: "Persistent config is disabled by FICTA_CONFIG_FILE=0; edit the proxy environment and restart.",
    };
  }

  const validation = validatePatch(patch);
  if (!validation.ok) return validation;

  const envValues = readUserConfig(path);
  const locked = withDestroyAllLock(startupLocked, envValues, effectiveEditableValues(cfg).destroyCategories);
  for (const field of Object.keys(validation.patch) as EditableProxyConfigKey[]) {
    if (locked[field]) {
      return {
        ok: false,
        service: "ficta",
        status: "locked",
        field,
        message: `${locked[field] ?? `${FIELD_ENV[field]} is set in the proxy environment.`} Edit that environment value and restart instead.`,
      };
    }
  }

  for (const [field, value] of Object.entries(validation.patch) as Array<[EditableProxyConfigKey, EditableValue]>) {
    envValues[FIELD_ENV[field]] = envString(field, value);
    if (field === "piiBackends") delete envValues[LEGACY_BACKEND_ENV];
    if (field === "destroyCategories") pruneDestroyLabels(envValues, value as string[]);
  }
  writeUserConfig(envValues, path);

  return { ok: true, service: "ficta", edit: proxyConfigEditState(cfg, startupLocked) };
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "localhost") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const match = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part >= 0 && part <= 255) && parts[0] === 127;
}

type EditableValue = EditableProxyConfigValues[EditableProxyConfigKey];

type PatchValidation =
  | { ok: true; patch: Partial<EditableProxyConfigValues> }
  | { ok: false; service: "ficta"; status: "invalid_patch"; message: string; field?: EditableProxyConfigKey };

function validatePatch(value: unknown): PatchValidation {
  if (!isRecord(value)) return invalid("Config patch must be a JSON object.");
  const patch: Partial<EditableProxyConfigValues> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!EDITABLE_KEYS.has(key as EditableProxyConfigKey)) return invalid(`Unknown config field: ${key}.`);
    const field = key as EditableProxyConfigKey;
    const parsed = validateField(field, raw);
    if (!parsed.ok) return parsed;
    (patch as Record<EditableProxyConfigKey, EditableValue>)[field] = parsed.value;
  }
  return { ok: true, patch };
}

function validateField(
  field: EditableProxyConfigKey,
  value: unknown,
): { ok: true; value: EditableValue } | Extract<PatchValidation, { ok: false }> {
  switch (field) {
    case "failClosed":
    case "piiEnabled":
    case "piiFailClosed":
    case "secretShapesEnabled":
    case "allowCustomUpstream":
      return typeof value === "boolean" ? { ok: true, value } : invalid(`${field} must be a boolean.`, field);
    case "restoreIntoTools": {
      // Accept the three policy names; tolerate the historical booleans (true→all, false→none).
      const policy = normalizeRestoreIntoToolsPolicy(value);
      return policy ? { ok: true, value: policy } : invalid("restoreIntoTools must be all, none, or detected.", field);
    }
    case "piiBackends": {
      const backends = normalizePiiBackends(value);
      return backends ? { ok: true, value: backends } : invalid("piiBackends must include known PII backends.", field);
    }
    case "surrogateStyle":
      return value === "opaque" || value === "typed"
        ? { ok: true, value }
        : invalid("surrogateStyle must be opaque or typed.", field);
    case "piiPresidioUrl":
    case "piiOpenmedUrl":
      return validateUrlField(field, value);
    case "destroyCategories":
      return validateDestroyCategories(value);
  }
}

/**
 * Destroy categories go through the engine's own validation, so an edit can never write a value the
 * proxy would refuse at startup. `"*"` (destroy every detector finding) is refused here on purpose:
 * permanent removal is irreversible, so the control plane only turns it on for categories an
 * administrator names one by one. Operators who really want everything set it in TOML/env. Messages
 * never echo the submitted entries.
 */
function validateDestroyCategories(
  value: unknown,
): { ok: true; value: string[] } | Extract<PatchValidation, { ok: false }> {
  const field = "destroyCategories";
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return invalid("destroyCategories must be a list of detection category names.", field);
  }
  if (value.some((entry) => entry.trim() === DESTROY_ALL)) {
    return invalid(
      'destroyCategories cannot be "*" from the control plane; name each category, or set dispositions.destroy.categories in config.toml.',
      field,
    );
  }
  try {
    const { destroy } = resolveEngineConfig({ dispositions: { destroy: { categories: value } } }).dispositions;
    return { ok: true, value: [...destroy.categories] };
  } catch (error) {
    if (!(error instanceof InvalidEngineConfigError)) throw error;
    return invalid("destroyCategories must list detection category names such as credit-card.", field);
  }
}

function invalid(message: string, field?: EditableProxyConfigKey): Extract<PatchValidation, { ok: false }> {
  return { ok: false, service: "ficta", status: "invalid_patch", message, field };
}

function validateUrlField(
  field: "piiPresidioUrl" | "piiOpenmedUrl",
  value: unknown,
): { ok: true; value: string } | Extract<PatchValidation, { ok: false }> {
  if (typeof value !== "string") return invalid(`${field} must be a string.`, field);
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return invalid(`${field} must use http or https.`, field);
    }
    return { ok: true, value: value.trim().replace(/\/+$/, "") };
  } catch {
    return invalid(`${field} must be a valid URL.`, field);
  }
}

function lockedFields(): Partial<Record<EditableProxyConfigKey, string>> {
  const out: Partial<Record<EditableProxyConfigKey, string>> = {};
  for (const [field, env] of Object.entries(FIELD_ENV) as Array<[EditableProxyConfigKey, string]>) {
    if (process.env[env] !== undefined && !wasLoadedFromUserConfig(env)) {
      out[field] = `${env} is set in the proxy environment.`;
    }
  }
  if (process.env[LEGACY_BACKEND_ENV] !== undefined && !wasLoadedFromUserConfig(LEGACY_BACKEND_ENV)) {
    out.piiBackends = `${LEGACY_BACKEND_ENV} is set in the proxy environment.`;
  }
  return out;
}

function effectiveEditableValues(cfg: Config): EditableProxyConfigValues {
  const posture = configPosture(cfg);
  return {
    failClosed: posture.protection.failClosed,
    piiEnabled: posture.detection.pii.standalone,
    piiBackends: normalizeConfiguredPiiBackends(posture.detection.pii.configuredBackends),
    piiFailClosed: posture.detection.pii.failureMode === "fail-closed",
    piiPresidioUrl: process.env.FICTA_PII_PRESIDIO_URL?.trim().replace(/\/+$/, "") || "http://127.0.0.1:5002",
    piiOpenmedUrl: process.env.FICTA_PII_OPENMED_URL?.trim().replace(/\/+$/, "") || "http://127.0.0.1:5004",
    secretShapesEnabled: posture.detection.secretShapes.standalone,
    surrogateStyle: posture.protection.surrogateStyle,
    restoreIntoTools: posture.protection.restoreIntoTools,
    allowCustomUpstream: posture.transport.allowCustomUpstream,
    destroyCategories: destroyCategoriesOf(posture.dispositions?.destroy),
  };
}

function destroyCategoriesOf(destroy: { all: boolean; categories: readonly string[] } | undefined): string[] {
  if (!destroy) return [];
  return destroy.all ? [DESTROY_ALL] : [...destroy.categories];
}

/** The saved destroy categories (`["*"]` for destroy-everything), or `fallback` when unset or unusable. */
function destroyCategoriesValue(
  values: Record<string, string>,
  fallback: string[],
  locked: Partial<Record<EditableProxyConfigKey, string>>,
): string[] {
  if (locked.destroyCategories) return fallback;
  const raw = values[FIELD_ENV.destroyCategories];
  if (raw === undefined) return fallback;
  try {
    const categories = raw ? raw.split(",") : [];
    return destroyCategoriesOf(resolveEngineConfig({ dispositions: { destroy: { categories } } }).dispositions.destroy);
  } catch {
    return fallback;
  }
}

/** Lock the field while the saved (or, when unsaved, running) policy destroys every category. */
function withDestroyAllLock(
  locked: Partial<Record<EditableProxyConfigKey, string>>,
  values: Record<string, string>,
  effective: string[],
): Partial<Record<EditableProxyConfigKey, string>> {
  if (locked.destroyCategories) return locked;
  const saved = destroyCategoriesValue(values, effective, locked);
  return saved.includes(DESTROY_ALL) ? { ...locked, destroyCategories: DESTROY_ALL_LOCK } : locked;
}

/** Drop TOML labels for categories no longer destroyed, which the engine would otherwise refuse. */
function pruneDestroyLabels(values: Record<string, string>, categories: string[]): void {
  const raw = values[DESTROY_LABELS_ENV];
  if (!raw) return;
  let labels: unknown;
  try {
    labels = JSON.parse(raw);
  } catch {
    return; // leave a malformed setting for the proxy to report
  }
  if (!isRecord(labels)) return;
  const kept = Object.entries(labels).filter(([category]) => categories.includes(normalizeCategory(category)));
  if (kept.length === 0) delete values[DESTROY_LABELS_ENV];
  else values[DESTROY_LABELS_ENV] = JSON.stringify(Object.fromEntries(kept));
}

function boolValue(
  field: EditableProxyConfigKey,
  values: Record<string, string>,
  fallback: boolean,
  locked: Partial<Record<EditableProxyConfigKey, string>>,
): boolean {
  if (locked[field]) return fallback;
  return parseBoolean(values[FIELD_ENV[field]]) ?? fallback;
}

function stringValue(
  field: EditableProxyConfigKey,
  values: Record<string, string>,
  fallback: string,
  locked: Partial<Record<EditableProxyConfigKey, string>>,
): string {
  if (locked[field]) return fallback;
  return values[FIELD_ENV[field]]?.trim().replace(/\/+$/, "") || fallback;
}

function piiBackendsValue(
  values: Record<string, string>,
  fallback: PiiBackendName[],
  locked: Partial<Record<EditableProxyConfigKey, string>>,
): PiiBackendName[] {
  if (locked.piiBackends) return fallback;
  const backends = backendsFromCommaList(values.FICTA_PII_BACKENDS);
  if (backends) return backends;
  const legacyBackend = backendsFromCommaList(values[LEGACY_BACKEND_ENV]);
  return legacyBackend ?? fallback;
}

function surrogateStyleValue(
  values: Record<string, string>,
  fallback: "opaque" | "typed",
  locked: Partial<Record<EditableProxyConfigKey, string>>,
): "opaque" | "typed" {
  if (locked.surrogateStyle) return fallback;
  return values.FICTA_SURROGATE_STYLE?.trim().toLowerCase() === "typed" ? "typed" : fallback;
}

function restoreIntoToolsValue(
  values: Record<string, string>,
  fallback: EditableProxyConfigValues["restoreIntoTools"],
  locked: Partial<Record<EditableProxyConfigKey, string>>,
): EditableProxyConfigValues["restoreIntoTools"] {
  if (locked.restoreIntoTools) return fallback;
  const raw = values.FICTA_RESTORE_INTO_TOOLS;
  return raw === undefined ? fallback : restoreIntoToolsPolicy(raw);
}

function envString(field: EditableProxyConfigKey, value: EditableValue): string {
  switch (field) {
    case "failClosed":
    case "piiEnabled":
    case "piiFailClosed":
    case "secretShapesEnabled":
    case "allowCustomUpstream":
      return value ? "1" : "0";
    case "piiBackends":
    case "destroyCategories":
      return (value as string[]).join(",");
    case "restoreIntoTools":
    case "surrogateStyle":
    case "piiPresidioUrl":
    case "piiOpenmedUrl":
      return String(value);
  }
}

function editableValuesEqual(a: EditableProxyConfigValues, b: EditableProxyConfigValues): boolean {
  return (Object.keys(FIELD_ENV) as EditableProxyConfigKey[]).every((key) => {
    const av = a[key];
    const bv = b[key];
    // Destroy categories are a set: the same categories in another order need no restart.
    if (key === "destroyCategories") return sameSet(a.destroyCategories, b.destroyCategories);
    if (Array.isArray(av) && Array.isArray(bv)) return av.length === bv.length && av.every((item, i) => item === bv[i]);
    return av === bv;
  });
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function normalizeConfiguredPiiBackends(values: readonly string[]): PiiBackendName[] {
  return normalizePiiBackends(values) ?? ["regex"];
}

function backendsFromCommaList(value: string | undefined): PiiBackendName[] | undefined {
  if (value === undefined) return undefined;
  return normalizePiiBackends(
    value
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
