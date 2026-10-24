# @serovaai/ficta-engine

## 0.12.0

### Patch Changes

- [#147](https://github.com/SerovaAI/ficta/pull/147) [`322344c`](https://github.com/SerovaAI/ficta/commit/322344c0b99ff2f0f025eaa0628b14ace65f6713) Thanks [@steflsd](https://github.com/steflsd)! - Stop the secret-shape detector from flagging two kinds of ordinary text: absolute filesystem paths (an agent's scratchpad or temp directory, read as one long opaque token), and an environment variable name that follows a secret-ish name in a listing (`JWT_PRIVATE_KEY` then `RESEND_API_KEY`, read as a name and its value). Both were redacted on some turns and not others.

## 0.11.0

### Patch Changes

- [#146](https://github.com/SerovaAI/ficta/pull/146) [`80e8882`](https://github.com/SerovaAI/ficta/commit/80e8882fdb104b69529819d125dfc92b9d105b87) Thanks [@steflsd](https://github.com/steflsd)! - Scan and forward request bodies literal by literal. A value hidden behind a duplicate JSON key (`{"content":"<secret>","content":"hi"}`) is now redacted and seen by the leak gate, where before the parse kept only the last value while the original bytes, secret included, were forwarded. Redaction no longer re-serializes the body, so integers above 2^53 and formatting reach the provider unchanged. A registered value written inside token-shaped text that this scope never minted (a 32-hex key written as `FICTA_<key>`) is now redacted and leak-checked instead of being exempt.

- [#144](https://github.com/SerovaAI/ficta/pull/144) [`827bd65`](https://github.com/SerovaAI/ficta/commit/827bd6572473063c79ccca4245e3c1a2bb7a69eb) Thanks [@steflsd](https://github.com/steflsd)! - Apply `restore_into_tools` to Codex freeform tools. A registry secret placed in a Responses `custom_tool_call` (`apply_patch`) or `local_shell_call`, or in a chat custom tool call, is now withheld under the default `detected` policy instead of being restored. This covers buffered bodies, streamed `custom_tool_call_input` deltas (including a token split across them), and replay events. The `response.function_call_arguments.done` and `response.custom_tool_call_input.done` events, which re-send the whole input, are withheld too. Restored values in freeform input are no longer JSON-escaped.

- [#143](https://github.com/SerovaAI/ficta/pull/143) [`0ddb717`](https://github.com/SerovaAI/ficta/commit/0ddb717f606e8023555f4cd2a687b37714fb7c37) Thanks [@steflsd](https://github.com/steflsd)! - Fix two exact-match guarantee gaps. A registered value that JSON-escapes (a quote, backslash or newline) is now redacted and leak-checked inside OpenAI tool-call `arguments`, which carry JSON text inside a JSON string. A registry secret that a detector also sees in a header or query string now stays a registry secret, so the default `restore_into_tools=detected` keeps withholding it from tool calls, including in keyed scopes whose stores hold a detected copy written by an earlier release.

## 0.10.0

### Minor Changes

- [#124](https://github.com/SerovaAI/ficta/pull/124) [`f635717`](https://github.com/SerovaAI/ficta/commit/f63571743455136785c2d41c558cb46f840a73a7) Thanks [@steflsd](https://github.com/steflsd)! - Proxy: gate the per-agent proxy with a per-launch caller token. The CLI mints a random token and bakes it into the launched agent's base URL (`/__ficta_l/<token>/…`); the proxy strips and verifies it before routing — and never forwards it upstream — refusing any provider-bound request that does not carry it (a health probe stays exempt). This stops another process sharing the loopback port from using the proxy to restore a known placeholder to its real value. The launched agent carries the token transparently, so no agent configuration changes. `startProxy` takes a new optional `launchToken`; omit it (as the multi-tenant Gateway proxy does) to keep the prior behavior.

- [#128](https://github.com/SerovaAI/ficta/pull/128) [`c443347`](https://github.com/SerovaAI/ficta/commit/c443347c0ab04a1f77bc6736027d0a80c0dce351) Thanks [@steflsd](https://github.com/steflsd)! - Add `restore_prose` / `FICTA_RESTORE_PROSE`, the restore-into-tools policy's analogue for assistant prose. It defaults to `all` (no behavior change — registered secrets round-trip into the model's reply as before, since prose is ficta's core restore surface). High-assurance deployments can opt into withholding: `detected` keeps locally-read detected content but renders registry/env secrets the model only ever saw as placeholders as `[ficta:withheld]`, and `none` withholds every mapped value from prose. This closes the prose + transcript-echo rehydration path for deployments that choose it, without disabling the default round-trip. Tool-call arguments remain governed separately by `restore_into_tools`.

### Patch Changes

- [#131](https://github.com/SerovaAI/ficta/pull/131) [`a96c76a`](https://github.com/SerovaAI/ficta/commit/a96c76ae2c5801928d950ce10c26d8bd527cbd25) Thanks [@steflsd](https://github.com/steflsd)! - Secret-shape detection no longer redacts hex digests whose label names them as one (`sha256: …`, `"commit": "…"`, `checksum=…`, `git log`'s `commit …`) or Subresource Integrity values (`integrity: sha512-…`), so agents can still edit and verify hashes verbatim. Bare unlabelled hex values, and digests under a label that also names a secret (`api_key_sha256`), are still treated as opaque secrets.

- [#126](https://github.com/SerovaAI/ficta/pull/126) [`ea2935c`](https://github.com/SerovaAI/ficta/commit/ea2935c820b8024cd43185b23fbbed65da5ae25e) Thanks [@steflsd](https://github.com/steflsd)! - Harden the per-launch proxy token and scope its guarantee accurately. Codex receives the token through an env-mapped `x-ficta-launch` header instead of its `base_url` command-line override, so the token value no longer appears in `ps`-visible argv (the proxy accepts the token via that header as well as the base-URL path, and sweeps it before forwarding upstream). The threat model now states plainly that the token stops a process that reaches the loopback port without inspecting the launched agent, not a same-user process that can read the agent's env/argv/config. Adds regression tests: token absent from Codex argv, header-based acceptance, and the token never written to the log directory.

- [#124](https://github.com/SerovaAI/ficta/pull/124) [`f635717`](https://github.com/SerovaAI/ficta/commit/f63571743455136785c2d41c558cb46f840a73a7) Thanks [@steflsd](https://github.com/steflsd)! - Proxy: never rehydrate surrogates in a non-2xx response body. A provider error reflects request fields back (e.g. `model: FICTA_… not found`), so restoring error bodies let any caller who knew a placeholder recover its real value by sending a deliberately-malformed request — no provider auth needed. Error bodies now pass through with the placeholder intact; successful (2xx) round-trips, including on non-standard routes, are unchanged.

- [`16f747e`](https://github.com/SerovaAI/ficta/commit/16f747ea90a4fb6b0394e339b95c62e7a2262aee) Thanks [@steflsd](https://github.com/steflsd)! - Proxy: never edit a caller's string Anthropic `system` prompt when adding the literal-preservation instruction. The prompt now stays verbatim as its own first block, with the instruction in a second block. Previously the instruction was appended to the string, which broke subscription (OAuth) requests that must carry the exact Agent SDK prompt (such as the Claude Code security-review hook): api.anthropic.com answered every retry with a bare `429 rate_limit_error "Error"`.

- [#127](https://github.com/SerovaAI/ficta/pull/127) [`a70e340`](https://github.com/SerovaAI/ficta/commit/a70e34099932cdd2c369f8f4af323f85c4833ff4) Thanks [@steflsd](https://github.com/steflsd)! - Residual-surrogate guard, Phase 2: once the proxy is protecting, a surrogate-shaped token that survives restore in client-visible text (a mutated/invented token, or an unmappable reference from another scope) is replaced with the neutral marker `[ficta:unrestored]` instead of reaching the agent as a raw `FICTA_…` string it might echo into a file. Mapped tokens — including deliberately withheld tool-call placeholders — are untouched, so only genuine debris is rewritten, and the no-cross-request-leak guarantee is unchanged. The marker for the client-requested `x-ficta-unknown-token: replace` preview is unified to the same string.

- [#133](https://github.com/SerovaAI/ficta/pull/133) [`76e1e78`](https://github.com/SerovaAI/ficta/commit/76e1e78efdbf0b5b8344b2820ddc766a0a7ab45f) Thanks [@steflsd](https://github.com/steflsd)! - Neutralize restore-highlight delimiters written by the upstream model (raw or JSON-escaped, in a single linear pass) before restoring, so a model can't forge a "restored from registry" highlight or shield a leftover placeholder from unknown-token replacement.

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
