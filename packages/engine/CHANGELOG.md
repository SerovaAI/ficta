# @serovaai/ficta-engine

## 0.9.0

### Minor Changes

- [`5cd450f`](https://github.com/SerovaAI/ficta/commit/5cd450f06b3e6e6c57c83df919d0e8d7b559c428) Thanks [@steflsd](https://github.com/steflsd)! - Bring engine policies and roster validation into the proxy, replace unknown Gateway response references before delivery, and persist restoration counts with active-registry fingerprints.

### Patch Changes

- [#123](https://github.com/SerovaAI/ficta/pull/123) [`8b898e3`](https://github.com/SerovaAI/ficta/commit/8b898e35894bfa1b36a8d8b85d5a3a74cb356b2a) Thanks [@steflsd](https://github.com/steflsd)! - A value a keyed scope already holds a token for keeps that token in a destroying profile instead of becoming a destroy marker. Previously a narrowed first pass under `destroy: { categories: "*" }` destroyed names a second pass had tokenised once a later run reopened the vault, so the same text got a token in one run and a marker in the next.

- [`2275437`](https://github.com/SerovaAI/ficta/commit/2275437e1e3ea4099316a9fd96fd37e726820866) Thanks [@steflsd](https://github.com/steflsd)! - Make permanent removal of detected categories an opt-in setting editable from the control plane (`destroyCategories`, mapped to `dispositions.destroy.categories`; `"*"` stays TOML/env-only and locks the field), and turn it off in the Gateway reference deployment so detected values are restored by default.

- [`a6ec67b`](https://github.com/SerovaAI/ficta/commit/a6ec67b9cd9b96c10a100a1622463db2f561caa5) Thanks [@steflsd](https://github.com/steflsd)! - A roster or managed-registry form shared by more than one entry is no longer dropped: it links to no entry but stays registered as an exact-match, whole-word value with its own unlinked token.

## 0.8.0

### Minor Changes

- [#118](https://github.com/SerovaAI/ficta/pull/118) [`41ebc32`](https://github.com/SerovaAI/ficta/commit/41ebc32c71c24d761e4aadd67a5ca1b782a8fd56) Thanks [@steflsd](https://github.com/steflsd)! - Library roster: `createEngine({ roster })` takes known people and organisations (`RosterEntry` / `RosterSource`), matches them exactly before detection in every profile, links each entry's surfaces under one `FICTA_PERSON|ORG_<entity>_<surface>` family in keyed scopes, drops forms claimed by more than one entry, and exposes `rosterFingerprint` so processes can check they loaded the same roster.

- [#120](https://github.com/SerovaAI/ficta/pull/120) [`60ab447`](https://github.com/SerovaAI/ficta/commit/60ab44797ff3fd0ba8862de24c3b26731d25ceb0) Thanks [@steflsd](https://github.com/steflsd)! - Destroy dispositions accept `categories: "*"` to destroy every detector finding whatever its category (registered and roster values keep their surrogates), so a keyed two-pass flow persists only roster mappings. A keyed scope now re-applies a roster short form it already holds at word boundaries and with its linked entity token (also after hydrating from the vault store), instead of a literal token inside longer words. `redactMany` reports roster matches (`hits[].roster`) and warns once that their tokens cannot be restored.

## 0.7.0

### Minor Changes

- [#116](https://github.com/SerovaAI/ficta/pull/116) [`a20737b`](https://github.com/SerovaAI/ficta/commit/a20737baadae5ee05dc1e7ac3af47c252fc8cf0e) Thanks [@steflsd](https://github.com/steflsd)! - Engine: `createEngine`, a fail-closed library facade with named redaction profiles (entity allowlists, secret shapes, destroy dispositions), stateless `redactMany`, keyed-scope `pseudonymise`/`pseudonymiseMany`/`restore` with counts, token-safe `truncate`, and a typed `RedactionUnavailableError` that never returns partially redacted text

## 0.6.0

### Minor Changes

- [#110](https://github.com/SerovaAI/ficta/pull/110) [`234e8aa`](https://github.com/SerovaAI/ficta/commit/234e8aa21381f41ffaa9864566f9d04ca1f1d0cb) Thanks [@steflsd](https://github.com/steflsd)! - Engine: add an irreversible "destroy" disposition. `dispositions.destroy.categories` replaces detections of the chosen categories with a fixed marker (default `[REDACTED_<CATEGORY>]`, overridable per category) instead of a reversible surrogate; destroyed values are never stored in the vault and are reported as `destroyed` plus `disposition: "destroy"` hits. Registered values keep their surrogates.

- [#113](https://github.com/SerovaAI/ficta/pull/113) [`8a1f906`](https://github.com/SerovaAI/ficta/commit/8a1f906d5a146df810e7069d1813ce8f0151461a) Thanks [@steflsd](https://github.com/steflsd)! - Engine: `restoreTextDetailed(text, { unknownToken })` on the engine and on scopes restores a complete text and returns `{ text, restoredCount, unknownCount }`. Every token-shaped string the vault does not map (unknown, model-mutated, truncated, wildcard entity references, or pruned/forgotten from a vault store) is counted and, with `unknownToken`, replaced by that placeholder; it is never mapped to a value. Destroy markers are not tokens. `restoreText` and the JSON/streaming restores are unchanged.

- [#112](https://github.com/SerovaAI/ficta/pull/112) [`92e7036`](https://github.com/SerovaAI/ficta/commit/92e7036956c34c74ff34e5cbaed3f9efdc469968) Thanks [@steflsd](https://github.com/steflsd)! - Engine: persistent, encrypted vault for keyed scopes. Pass a `VaultStore` as `vault` and keyed scopes persist their value↔token mappings, so another process with the same surrogate and scope key can restore them and restarts lose nothing; values are encrypted with AES-256-GCM under a separate caller-supplied key, bound to their scope and token. New `@serovaai/ficta-engine/sqlite` entry (`openSqliteVaultStore`, Node >= 22.13) on built-in `node:sqlite` with WAL and a busy timeout, plus `prune` by last use and `forget(value)`. Scopes gain `hydrate()` and `prepareRestore(text)`; destroyed values are never stored. The main entry still loads on Node 20. Threat model updated: the CLI keeps mappings in memory; an embedding with a vault store writes encrypted mappings to disk.

- [#114](https://github.com/SerovaAI/ficta/pull/114) [`1893eae`](https://github.com/SerovaAI/ficta/commit/1893eae1dad32c24954048dcc43624913a6ee893) Thanks [@steflsd](https://github.com/steflsd)! - A valid, Luhn-passing South African ID number is now classified as an ID rather than a credit card, deterministically. The reference Presidio sidecar drops `CREDIT_CARD` when `ZA_ID_NUMBER` validated the same span; the PII plugin no longer lets backend result order pick a value's category and prefers a configured backend over the regex floor; and the engine adds `detection.entityPriority` (categories, highest first) for values reported under several categories. Destroying the ID category alone now destroys such an ID; it no longer needs `credit-card` destroyed too.

## 0.5.0

### Minor Changes

- [#108](https://github.com/SerovaAI/ficta/pull/108) [`ac2aeb3`](https://github.com/SerovaAI/ficta/commit/ac2aeb37b379070826e814cca59568011bc0a1ef) Thanks [@steflsd](https://github.com/steflsd)! - New package `@serovaai/ficta-engine` (experimental, 0.x): the redaction engine as a standalone library with no runtime dependencies, so other services can redact and restore in-process. It ships the built-in detectors as its default plugin set, adds `redactContentDetailed` for redacting plain strings as message content (every detector runs, including Presidio/OpenMed), and requires an explicit `config.surrogate.key` unless the caller passes `allowEphemeralKey: true`. `@serovaai/ficta` now builds on it and releases with it at the same version; the ficta CLI keeps its ephemeral-key fallback, and the `@serovaai/ficta/plugins` API is unchanged.
