import type { DetectionProfile } from "../types.js";

/**
 * Jurisdiction-scoped Presidio entity selection. Some recognizers are only sound inside their home
 * jurisdiction, so jurisdiction-specific recognizers stay enabled in the sidecar registry but are
 * reachable only when a request's detection profile asks for them.
 *
 * Additive-only contract: a profile UNIONS its bundles onto the baseline; it can never remove
 * baseline coverage. The effective list is therefore never empty — critical because an /analyze
 * payload without an `entities` field runs EVERY loaded recognizer, which would silently bypass
 * jurisdiction gating for default traffic.
 *
 * `DEFAULT_BASELINE_ENTITIES` must mirror the enabled recognizers in
 * `packages/ficta/presidio/default_recognizers.za.yaml` plus the identity recognizer baked into the
 * derived image (`ficta_presidio/identity_recognizer.py`). `scripts/verify-presidio-sidecar.mts`
 * gates drift in both directions against the live sidecar's `/supportedentities`.
 */

/** Presidio entity types added by each jurisdiction, on top of the baseline. */
export const JURISDICTION_ENTITY_BUNDLES: Readonly<Record<string, readonly string[]>> = {
  // za/us overlap the baseline today; the union keeps them harmless and future-proofs a
  // deployment that narrows FICTA_PII_PRESIDIO_ENTITIES below the default baseline.
  za: ["ZA_ID_NUMBER"],
  uk: ["UK_NHS", "UK_NINO", "UK_DRIVING_LICENCE", "UK_PASSPORT", "UK_POSTCODE", "UK_VEHICLE_REGISTRATION"],
  us: ["US_SSN", "US_BANK_NUMBER", "US_DRIVER_LICENSE", "US_ITIN", "US_PASSPORT", "MEDICAL_LICENSE"],
};

/**
 * The entity types every request may detect regardless of profile: exactly the recognizers enabled
 * in the sidecar registry YAML today, plus the identity recognizer's NER entities (which filters by
 * requested entities too — dropping one of those names silently disables NER coverage).
 */
export const DEFAULT_BASELINE_ENTITIES: readonly string[] = [
  // Locale-agnostic structured recognizers
  "CREDIT_CARD",
  "CRYPTO",
  "EMAIL_ADDRESS",
  "IBAN_CODE",
  "IP_ADDRESS",
  "MAC_ADDRESS",
  "PHONE_NUMBER",
  "URL",
  // Ficta custom recognizers (DOCUMENT_ID/ACCOUNT_NUMBER are deliberately locale-agnostic)
  "DOCUMENT_ID",
  "ACCOUNT_NUMBER",
  // Home + US jurisdiction recognizers enabled since the initial registry
  "ZA_ID_NUMBER",
  "US_BANK_NUMBER",
  "US_DRIVER_LICENSE",
  "US_ITIN",
  "US_PASSPORT",
  "US_SSN",
  "MEDICAL_LICENSE",
  // FictaSpacyIdentityRecognizer / FictaGlinerIdentityRecognizer NER entities
  "PERSON",
  "ORGANIZATION",
  "DATE_TIME",
  "LOCATION",
  "COMPANY_REGISTRATION",
];

/**
 * The entity allowlist one /analyze call must send: the configured list (or the default baseline
 * when none is configured) unioned with the profile's jurisdiction bundles. Unknown jurisdiction
 * codes contribute nothing. Never empty — see the module comment for why that must hold.
 */
export function effectivePresidioEntities(
  configured: readonly string[],
  profile: DetectionProfile | undefined,
): readonly string[] {
  const base = configured.length > 0 ? configured : DEFAULT_BASELINE_ENTITIES;
  const out = new Set(base);
  for (const code of profile?.jurisdictions ?? []) {
    // Own-key check: an inherited name like "constructor" must contribute nothing, not a function.
    if (!Object.hasOwn(JURISDICTION_ENTITY_BUNDLES, code)) continue;
    for (const entity of JURISDICTION_ENTITY_BUNDLES[code] ?? []) out.add(entity);
  }
  if (out.size === 0) throw new Error("effective presidio entity allowlist must never be empty");
  return [...out];
}

/**
 * Normalize raw jurisdiction codes to the supported, deduped, ordered subset (empty → undefined).
 * The engine's supported set is the bundle map's keys; the protocol package publishes the same
 * vocabulary (`SUPPORTED_DETECTION_JURISDICTIONS`) for callers, and the engine deliberately does
 * not import it (engine boundary: engine code imports only itself + node builtins) — a sync test
 * in `test/jurisdictions.test.ts` keeps the two lists identical.
 */
export function detectionProfileFromCodes(codes: readonly string[]): DetectionProfile | undefined {
  const jurisdictions = [
    ...new Set(
      codes
        .map((code) => code.trim().toLowerCase())
        // Own keys only: `in` would also admit inherited names like "constructor" or "__proto__".
        .filter((code) => Object.hasOwn(JURISDICTION_ENTITY_BUNDLES, code)),
    ),
  ];
  return jurisdictions.length > 0 ? { jurisdictions } : undefined;
}
