# Changelog

## 0.2.1

### Patch Changes

- [#83](https://github.com/SerovaAI/ficta/pull/83) [`08a6dcc`](https://github.com/SerovaAI/ficta/commit/08a6dcc6968a143f4c534ee2a281d42ca8a0a288) Thanks [@steflsd](https://github.com/steflsd)! - Fix secret-shape detection false positives that could misread an adjacent JSON object key as a secret value and corrupt the forwarded request body: JSON key→value secrets are now detected structurally from body leaves (new optional `detectBodyLeaves` plugin hook), and the pattern-detection view separates leaves with a boundary no match can cross.

- Updated dependencies []:
  - @serovaai/ficta-protocol@0.2.1

## 0.2.0

### Minor Changes

- [#60](https://github.com/SerovaAI/ficta/pull/60) [`083e548`](https://github.com/SerovaAI/ficta/commit/083e5488d8a518b1e9e70ed1dd5b7f25221c15d5) Thanks [@steflsd](https://github.com/steflsd)! - Enable context-bound entity-family surrogates for structured entities in trusted keyed request bodies and document their metadata boundary.

- [`2dbfc1a`](https://github.com/SerovaAI/ficta/commit/2dbfc1ac2b91f36d324a9c8c307c3a3e5223e9bd) Thanks [@steflsd](https://github.com/steflsd)! - Add live managed-registry reloads and Markdown-aware PII case coverage.

- [#40](https://github.com/SerovaAI/ficta/pull/40) [`726f504`](https://github.com/SerovaAI/ficta/commit/726f50408683fd05fc178aab6b89b2f189b00111) Thanks [@steflsd](https://github.com/steflsd)! - Enforce strict managed-registry contracts and separate engine, proxy, protocol, and Gateway responsibilities.

- [#58](https://github.com/SerovaAI/ficta/pull/58) [`b6c2cdf`](https://github.com/SerovaAI/ficta/commit/b6c2cdf913237bc3a36f28492feff37e1a06e6c2) Thanks [@steflsd](https://github.com/steflsd)! - Link unique high-confidence organization aliases to registered entity anchors and report values-free ambiguity counts in protection stats and egress proofs.

- [`7c8272c`](https://github.com/SerovaAI/ficta/commit/7c8272cd293c11ab31b4ab1e9633c2cbe44862c6) Thanks [@steflsd](https://github.com/steflsd)! - Standardize validation commands on `check`, replacing the `verify` and `verify:*` scripts.

- [#50](https://github.com/SerovaAI/ficta/pull/50) [`60cc3a5`](https://github.com/SerovaAI/ficta/commit/60cc3a56f44122a444f914617c106ad0831484e7) Thanks [@steflsd](https://github.com/steflsd)! - Move legal identity recognition into the Presidio sidecar, preserve structured regex protection, and add values-free trace diagnostics.

- [#59](https://github.com/SerovaAI/ficta/pull/59) [`9031dad`](https://github.com/SerovaAI/ficta/commit/9031dad8aebeff406eda86aeca5074d8b8f0a730) Thanks [@steflsd](https://github.com/steflsd)! - Add gated context-bound entity-family surrogate rendering and exact restoration across buffered, streaming, and tool-call transports.

- [#56](https://github.com/SerovaAI/ficta/pull/56) [`e465e5a`](https://github.com/SerovaAI/ficta/commit/e465e5adb883f2ff93a17e0acf3cc7c87ec5f085) Thanks [@steflsd](https://github.com/steflsd)! - Introduce the entity-aware managed registry v1 contract with explicit form boundaries, strict whole-registry validation, and restart-safe live reloads.

- [#66](https://github.com/SerovaAI/ficta/pull/66) [`efe1203`](https://github.com/SerovaAI/ficta/commit/efe120308145ae9e1213fa235bdb407cdd495865) Thanks [@steflsd](https://github.com/steflsd)! - Observe residual surrogate tokens that survive restore. A surrogate-shaped token with no dictionary mapping — mutated, truncated, or invented by the model (e.g. a wildcard entity-family reference like `FICTA_ORG_<entityTag>_*`) — is now counted per response and surfaced as a values-free total in the proxy log (`⚠️ N unrestored surrogate token(s)`), `protection-stats.json`, and the stats summary. Detection covers opaque, typed, and entity-family token shapes plus entity-family prefix fragments, across buffered, streamed, and SSE restore paths. Observe-only: response bytes are unchanged, and restore remains exact-match — unknown tokens are never fuzzily recovered.

- [#79](https://github.com/SerovaAI/ficta/pull/79) [`b96f1b0`](https://github.com/SerovaAI/ficta/commit/b96f1b06cf11453da0e11cece692077d50c80ca8) Thanks [@steflsd](https://github.com/steflsd)! - Country-scoped Presidio registry. The shipped recognizer config (renamed
  `presidio/default_recognizers.za.yaml` → `presidio/default_recognizers.yaml`) is now fully
  country-tagged, and the sidecar's `FICTA_PRESIDIO_SUPPORTED_COUNTRIES` env var (default `za,us,mu`,
  the SA-legal reference profile) decides at load time which country-specific recognizers run;
  locale-agnostic recognizers always load. Notably, the UK NHS recognizer no longer runs on default
  traffic — add `uk` to the country scope for UK-matter deployments. `FICTA_PII_PRESIDIO_ENTITIES`
  is now a pure optional narrowing allowlist: when unset, `/analyze` requests omit the `entities`
  field and the deployment's loaded registry is the detection surface. The proxy also now strips
  every inbound `x-ficta-*` header before forwarding upstream, instead of enumerating known ones.

- [#42](https://github.com/SerovaAI/ficta/pull/42) [`35b2e33`](https://github.com/SerovaAI/ficta/commit/35b2e33f0d7f1cf6fdc1fd6a41a3382df9f8d1df) Thanks [@steflsd](https://github.com/steflsd)! - Add a runtime-admin grant for per-chat raw trace capture and decouple capture from log verbosity.

### Patch Changes

- [`b19cf46`](https://github.com/SerovaAI/ficta/commit/b19cf46a1711b3cda5bc873add03e45079352f6b) Thanks [@steflsd](https://github.com/steflsd)! - Align source-checkout Presidio startup, logging-root configuration, and documented runtime defaults.

- [#41](https://github.com/SerovaAI/ficta/pull/41) [`1bd5178`](https://github.com/SerovaAI/ficta/commit/1bd517801a7aefcbf265e8f95cd090e50f4fc8fb) Thanks [@steflsd](https://github.com/steflsd)! - Allow attachment-only Gateway drafts to enter protection review or send with the existing generic review instruction.

- [`2f3bf7f`](https://github.com/SerovaAI/ficta/commit/2f3bf7f7c5744c7f4186570439ed0c9f3601823c) Thanks [@steflsd](https://github.com/steflsd)! - Carry transient UTF-16 source spans through the PII detector contract for offset-based redaction.

- [`737e967`](https://github.com/SerovaAI/ficta/commit/737e9678f42b1febb1b20cfb4f9be91a162bbaae) Thanks [@steflsd](https://github.com/steflsd)! - Consolidate CI, secret scanning, and release automation into one gated workflow run.

- [`0b26f15`](https://github.com/SerovaAI/ficta/commit/0b26f15cef26fbb3a02501da85e4f4afb111f79e) Thanks [@steflsd](https://github.com/steflsd)! - Detect organization names via Presidio NER. Ship an NLP-engine config (`presidio/nlp_engine.za.yaml`, mounted as `NLP_CONF_FILE`) that un-suppresses `ORGANIZATION` — upstream ignores it as "many false positives" — so unregistered client/counterparty/company names get a best-effort catch from spaCy `en_core_web_lg`. This is probabilistic and over-redacts (headings, common nouns); exact confidentiality still comes from the registered-value registry.

- [`af9dea2`](https://github.com/SerovaAI/ficta/commit/af9dea2cd48bef947e15e97d7160520805a9f175) Thanks [@steflsd](https://github.com/steflsd)! - Document routing `ficta claude` through a local Anthropic-compatible proxy via `FICTA_ANTHROPIC_UPSTREAM`, so an alt model (e.g. GPT‑5.6 "sol" behind CLIProxyAPI on a ChatGPT subscription) can run with redaction intact. Loopback upstreams need no `FICTA_ALLOW_CUSTOM_UPSTREAM`.

- [#48](https://github.com/SerovaAI/ficta/pull/48) [`6dd6b82`](https://github.com/SerovaAI/ficta/commit/6dd6b82d2ebe6c446a905452c85d5f8456986b20) Thanks [@steflsd](https://github.com/steflsd)! - Explain restored-value underlines with accessible origin-specific tooltips.

- [`e2eb4a4`](https://github.com/SerovaAI/ficta/commit/e2eb4a4d62d11985fc402274aba9f5a4ecbd5330) Thanks [@steflsd](https://github.com/steflsd)! - Redact embedded case variants of registered and detected entities and add explicit boundary policy for future aliases.

- [`bd8448e`](https://github.com/SerovaAI/ficta/commit/bd8448e420a4da958fccae960e3f74a86e64a3b9) Thanks [@steflsd](https://github.com/steflsd)! - Improve Presidio organization coverage for accounting tables and same-document business variants while filtering structural NER false positives.

- [`f3cbc49`](https://github.com/SerovaAI/ficta/commit/f3cbc4949d9bc28f622a187e5c251d2b1a1f8cdd) Thanks [@steflsd](https://github.com/steflsd)! - Live protected registry: values published from the gateway admin UI take effect in the running proxy without a restart. New `POST /__ficta/registry/reload` (loopback-gated, request body ignored, counts-only response including `skippedTooShort` for values below `FICTA_REGISTRY_MIN_LEN`), `ProtectionEngine.reloadRegistryValues()` registering new managed-file values into the live vault, and a stat-based cache key for the managed-registry plugin (a rewritten file is actually re-read — also fixes stale registry counts in per-request log metadata and `ficta doctor`). Additions are live; deletions still apply on restart (removing a value mid-process would break restore of surrogates already in transcripts). Protocol gains `FICTA_REGISTRY_RELOAD_PATH`, `RegistryReloadOk/Error`, and `isRegistryReloadOk`.

- [`ee44595`](https://github.com/SerovaAI/ficta/commit/ee44595a6ebfb79f96b058022ac99ec70cbc9806) Thanks [@steflsd](https://github.com/steflsd)! - Map compact Markdown detection offsets back to raw request ranges so internally formatted entities are fully redacted.

- [`f3cbc49`](https://github.com/SerovaAI/ficta/commit/f3cbc4949d9bc28f622a187e5c251d2b1a1f8cdd) Thanks [@steflsd](https://github.com/steflsd)! - Close two systemic PII-miss classes observed on markitdown-converted documents:

  - **Markdown-aware NER input**: NLP backends (Presidio/OpenMed) now detect over compact Markdown-normalized text with exact raw-offset mapping (`**bold**`, `\_` escapes, `###` headings, list markers, `~~strike~~`), fixing contaminated spans, internal-formatting gaps, and recall lost to formatting; regex recognizers keep the raw text.
  - **Case-variant coverage**: an entity detected in one casing is redacted in every casing actually present in the request (title-case prose vs ALL-CAPS headings/signature blocks), for detected PII and word/name-like registry values alike (digit-bearing secrets are never case-folded). Registry-derived variants carry `permanent` provenance, so the `detected` restore-into-tools policy withholds a secret's case twin from tool-call arguments exactly like the canonical form.

- [#70](https://github.com/SerovaAI/ficta/pull/70) [`64335d9`](https://github.com/SerovaAI/ficta/commit/64335d9e8305f7a2c2f7a1f0fd7fc537f9a15754) Thanks [@steflsd](https://github.com/steflsd)! - Neutralize caller-provenance labels: explicit pre-send selections are now recorded with
  `source: "user-selected"` and `plugin: "protection-preview"` (previously `gateway-user` /
  `gateway-preview`). The strings appear in protection-preview findings, traces, and stats labels;
  no behavior depends on them.

- [#34](https://github.com/SerovaAI/ficta/pull/34) [`50a49f7`](https://github.com/SerovaAI/ficta/commit/50a49f7be1e9d5457ff22b5f91d83ff9187d3c74) Thanks [@steflsd](https://github.com/steflsd)! - Add a gateway trace-capture header so raw proxy trace/audit capture can be scoped per chat thread.

- [`2d55f15`](https://github.com/SerovaAI/ficta/commit/2d55f15723805a49acbb82c6bce94ad6670cd22f) Thanks [@steflsd](https://github.com/steflsd)! - Add a loopback-only pre-send protection preview with resolver-authored spans and content-bound, single-use tickets for user-selected chat protections.

- [`0b26f15`](https://github.com/SerovaAI/ficta/commit/0b26f15cef26fbb3a02501da85e4f4afb111f79e) Thanks [@steflsd](https://github.com/steflsd)! - Add an opt-in `FICTA_PRESERVE_LITERALS` mode that injects a system/developer instruction carrying the exact surrogate tokens present in each outbound request, telling the model to reproduce them verbatim. This improves restore reliability: models otherwise truncate or editorialise long opaque tokens (`FICTA_62a02923…`), which leaves them unrestorable. The instruction only ever adds surrogate tokens the proxy already minted (never raw values) and runs after the fail-closed leak gate.

- [`f195c54`](https://github.com/SerovaAI/ficta/commit/f195c54bb903e069315f071a7c0d4244028065ba) Thanks [@steflsd](https://github.com/steflsd)! - Record fail-closed detector outages across body, query, and header surfaces as explicit values-free blocked-request proof events.

- [`aacf45d`](https://github.com/SerovaAI/ficta/commit/aacf45da59635a71f1bc93eb2eaa798851cfeb21) Thanks [@steflsd](https://github.com/steflsd)! - Keep published documentation focused on shipped behavior and public threat-model boundaries, with private strategy and future-roadmap material maintained separately.

- [#39](https://github.com/SerovaAI/ficta/pull/39) [`b60f2bf`](https://github.com/SerovaAI/ficta/commit/b60f2bf2a8c829499bb38491ec73159d96398fc3) Thanks [@steflsd](https://github.com/steflsd)! - Move request captures into lazy `runs/run-*` directories and write current protection stats to `protection-stats.json`.

- [`89da819`](https://github.com/SerovaAI/ficta/commit/89da8193c2d0ff8cec4577f171d9ec46a54b1b05) Thanks [@steflsd](https://github.com/steflsd)! - Enforce required-registry readiness on standalone provider traffic and expose the blocking state to Gateway.

- [#74](https://github.com/SerovaAI/ficta/pull/74) [`f640551`](https://github.com/SerovaAI/ficta/commit/f6405517fc14f7e586e78151b600a587bcd72217) Thanks [@steflsd](https://github.com/steflsd)! - Skip Doppler registry API and secret-loading commands when the launch directory has no resolvable Doppler scope.

- [`f3cbc49`](https://github.com/SerovaAI/ficta/commit/f3cbc4949d9bc28f622a187e5c251d2b1a1f8cdd) Thanks [@steflsd](https://github.com/steflsd)! - Audit attribution now prefers the registry's identity when a value is both a registered secret and a probabilistic detection: the trace/stats report `env-file / secret / exact` (e.g. `CLIENT_CFO`) instead of the detector's guess (`person / pii / high`). Reporting only — span selection, surrogates, restore, and restore-into-tools provenance are unchanged.

- [`7202694`](https://github.com/SerovaAI/ficta/commit/720269476b3631cba3d2fc5122cb366568ca0e6b) Thanks [@steflsd](https://github.com/steflsd)! - Resolve overlapping body entities by source spans so registered values win exact boundaries without partial leaks.

- [`f3cbc49`](https://github.com/SerovaAI/ficta/commit/f3cbc4949d9bc28f622a187e5c251d2b1a1f8cdd) Thanks [@steflsd](https://github.com/steflsd)! - Scope trace-mode restore-highlight markers to assistant output. The highlight triple (the gateway's show/hide toggle format) now rides only on streamed text fragments and their sibling fields; metadata/replay events that echo the request back (`response.created` / `response.in_progress` `instructions`) restore plainly — surrogates still never reach the client, but the echoed preamble is no longer littered with marker sentinels.

- [`7625390`](https://github.com/SerovaAI/ficta/commit/762539003aef48436c50dbdb701caad8f1872e66) Thanks [@steflsd](https://github.com/steflsd)! - Restore repeated document-linked short organization aliases in Presidio identity detection.

- [#47](https://github.com/SerovaAI/ficta/pull/47) [`2f799b0`](https://github.com/SerovaAI/ficta/commit/2f799b08760c6a02532f09a26e4c997908b0f14e) Thanks [@steflsd](https://github.com/steflsd)! - Highlight locally restored response values without requiring sensitive trace capture.

- [`e79624e`](https://github.com/SerovaAI/ficta/commit/e79624e1195c3689dba07eb935b4ea04caca6abd) Thanks [@steflsd](https://github.com/steflsd)! - Separate capture logs by proxy role so concurrent instances no longer share one directory. The
  standalone/web server now writes under `~/.ficta/logs/gateway/`, and each `ficta <agent>` shim under
  `~/.ficta/logs/agents/<agent>/<instance>/` (one subtree per process, so two `ficta claude` sessions
  never interleave `runs/` or race `protection-stats.json`). Set `FICTA_LOG_ROOT` to relocate the root;
  `FICTA_LOG_DIR` still fully overrides the exact path. Existing `config.toml` files whose
  `[logging].log_dir` equals the default root are treated as neutral so the split applies.

- [`1ae6497`](https://github.com/SerovaAI/ficta/commit/1ae6497646e95d6bc7dfc9839cfa71a9474ff47e) Thanks [@steflsd](https://github.com/steflsd)! - Preserve contained PII candidates for occurrence resolution and add legal-document ID, Mauritius phone, and ordinal-date Presidio coverage.

- [`8c09e18`](https://github.com/SerovaAI/ficta/commit/8c09e18ada996917759f630f4a8a85b87d3cbb69) Thanks [@steflsd](https://github.com/steflsd)! - Add values-free, per-thread provider-egress evidence for Gateway chats.

- [`89da819`](https://github.com/SerovaAI/ficta/commit/89da8193c2d0ff8cec4577f171d9ec46a54b1b05) Thanks [@steflsd](https://github.com/steflsd)! - Simplify the documented POC configuration and have setup emit only the canonical multi-backend PII setting.

- [`2dbfc1a`](https://github.com/SerovaAI/ficta/commit/2dbfc1ac2b91f36d324a9c8c307c3a3e5223e9bd) Thanks [@steflsd](https://github.com/steflsd)! - Harden live Protected Registry publication: Gateway now writes private registry files atomically, serializes publish transactions, and verifies a per-generation revision echoed by the proxy together with managed-source health counts. Hosted Gateway deployments are explicitly bound to one WorkOS organization via `FICTA_GATEWAY_ORG_ID`, matching the proxy's process-global permanent registry.

- Updated dependencies [[`083e548`](https://github.com/SerovaAI/ficta/commit/083e5488d8a518b1e9e70ed1dd5b7f25221c15d5), [`1bd5178`](https://github.com/SerovaAI/ficta/commit/1bd517801a7aefcbf265e8f95cd090e50f4fc8fb), [`2dbfc1a`](https://github.com/SerovaAI/ficta/commit/2dbfc1ac2b91f36d324a9c8c307c3a3e5223e9bd), [`726f504`](https://github.com/SerovaAI/ficta/commit/726f50408683fd05fc178aab6b89b2f189b00111), [`737e967`](https://github.com/SerovaAI/ficta/commit/737e9678f42b1febb1b20cfb4f9be91a162bbaae), [`af9dea2`](https://github.com/SerovaAI/ficta/commit/af9dea2cd48bef947e15e97d7160520805a9f175), [`b6c2cdf`](https://github.com/SerovaAI/ficta/commit/b6c2cdf913237bc3a36f28492feff37e1a06e6c2), [`f3cbc49`](https://github.com/SerovaAI/ficta/commit/f3cbc4949d9bc28f622a187e5c251d2b1a1f8cdd), [`50a49f7`](https://github.com/SerovaAI/ficta/commit/50a49f7be1e9d5457ff22b5f91d83ff9187d3c74), [`2d55f15`](https://github.com/SerovaAI/ficta/commit/2d55f15723805a49acbb82c6bce94ad6670cd22f), [`f195c54`](https://github.com/SerovaAI/ficta/commit/f195c54bb903e069315f071a7c0d4244028065ba), [`aacf45d`](https://github.com/SerovaAI/ficta/commit/aacf45da59635a71f1bc93eb2eaa798851cfeb21), [`7c8272c`](https://github.com/SerovaAI/ficta/commit/7c8272cd293c11ab31b4ab1e9633c2cbe44862c6), [`89da819`](https://github.com/SerovaAI/ficta/commit/89da8193c2d0ff8cec4577f171d9ec46a54b1b05), [`9031dad`](https://github.com/SerovaAI/ficta/commit/9031dad8aebeff406eda86aeca5074d8b8f0a730), [`e465e5a`](https://github.com/SerovaAI/ficta/commit/e465e5adb883f2ff93a17e0acf3cc7c87ec5f085), [`efe1203`](https://github.com/SerovaAI/ficta/commit/efe120308145ae9e1213fa235bdb407cdd495865), [`2f799b0`](https://github.com/SerovaAI/ficta/commit/2f799b08760c6a02532f09a26e4c997908b0f14e), [`b96f1b0`](https://github.com/SerovaAI/ficta/commit/b96f1b06cf11453da0e11cece692077d50c80ca8), [`8c09e18`](https://github.com/SerovaAI/ficta/commit/8c09e18ada996917759f630f4a8a85b87d3cbb69), [`35b2e33`](https://github.com/SerovaAI/ficta/commit/35b2e33f0d7f1cf6fdc1fd6a41a3382df9f8d1df), [`89da819`](https://github.com/SerovaAI/ficta/commit/89da8193c2d0ff8cec4577f171d9ec46a54b1b05), [`2dbfc1a`](https://github.com/SerovaAI/ficta/commit/2dbfc1ac2b91f36d324a9c8c307c3a3e5223e9bd)]:
  - @serovaai/ficta-protocol@0.2.0

## 0.1.3

### Patch Changes

- [`0edb7be`](https://github.com/SerovaAI/ficta/commit/0edb7be46f58a7dbc674687877a24d1c5ba00185) Thanks [@steflsd](https://github.com/steflsd)! - Limit the shipped Presidio recognizer registry to English-language recognizers so the sidecar no longer declares unsupported language variants at startup.

- [#18](https://github.com/SerovaAI/ficta/pull/18) [`6e5ff5e`](https://github.com/SerovaAI/ficta/commit/6e5ff5e33e56ee7c4a8010d6d1e218caf90b2c6a) Thanks [@steflsd](https://github.com/steflsd)! - Add restore-highlight surrogate metadata for Gateway privacy display toggles and keep streamed marker output from being restored twice.

- Updated dependencies [[`6e5ff5e`](https://github.com/SerovaAI/ficta/commit/6e5ff5e33e56ee7c4a8010d6d1e218caf90b2c6a), [`bac69df`](https://github.com/SerovaAI/ficta/commit/bac69df7879228a70a2573b1f436be39f5adc7b8)]:
  - @serovaai/ficta-protocol@0.1.3

## 0.1.2

### Patch Changes

- [`ee785fe`](https://github.com/SerovaAI/ficta/commit/ee785feb121c0e88f233792143cdf017f6be58dd) Thanks [@steflsd](https://github.com/steflsd)! - Remove the unused `redactableBodyText` export — use `redactableBodyLeaves` (the same JSON string leaves, returned unjoined). Internal dead-code cleanup; redaction behavior is unchanged.

- Updated dependencies []:
  - @serovaai/ficta-protocol@0.1.2

## 0.1.1 - 2026-07-08

### Added

- Added native multi-backend PII detection with an `openmed` backend for medical workflows. Ficta
  can now run `presidio` and `openmed` backends together via `FICTA_PII_BACKENDS` / `[pii] backends`,
  keeping Microsoft Presidio and the upstream OpenMed REST service (run unmodified, called via its
  native `/pii/extract` API, configured under `[pii.openmed]`) in separate containers while Ficta
  coordinates failures, probes `/health` in `ficta doctor` and the status endpoint, and merges
  detected values with medical-specificity preference. In the source checkout, both sidecars can be
  started via the repo-root `docker-compose.sidecars.yml` (`pnpm sidecars`), and root `pnpm dev`
  auto-manages the sidecars for the backends selected via `FICTA_PII_BACKENDS`.

### Changed

- Updated the Gateway proxy-configuration control plane to edit the multi-backend PII setting (`FICTA_PII_BACKENDS`) and expose OpenMed/medical detection alongside Regex and Presidio.
- Added an admin-only Ficta Gateway editor for proxy safety settings. Gateway now reads editable proxy metadata, writes a narrow loopback-only `PATCH /__ficta/config` to persist changes into `config.toml`, leaves explicit `FICTA_*` environment overrides locked, and warns that saved settings require a proxy restart before they affect the running posture. The proxy/Gateway control-plane wire contracts now live in the new dependency-free `@serovaai/ficta-protocol` package.
- Route Ficta Gateway dev startup through the same Doppler-aware env wrapper as the root dev command, falling back to local `.env` files when the Doppler CLI is unavailable.
- Documented how to repair agent shims when the installed `ficta` CLI path moves, including published package reinstalls, durable local source-checkout installs, stale generated launcher guidance, and local installs whose global `ficta` wrapper is already broken.

### Fixed

- Moved Ficta Gateway's TanStack Query setup into the router-level SSR integration and added an in-menu retry action for workspace-switcher load failures.
- Show the active WorkOS workspace name in the Ficta Gateway account menu and surface workspace-load failures instead of silently hiding the switcher.
- Prewarm Ficta Gateway TanStack Start server functions in dev so cold server-function requests no longer fail with `Invalid server function ID`.
- Aligned the published package-local pnpm pin with the workspace release toolchain so package publish scripts run under pnpm 11.10.0.

## 0.1.0 - 2026-07-04

### Added

- Added opt-in **typed surrogates**. `FICTA_SURROGATE_STYLE=typed` mints `FICTA_<TYPE>_<hex>` (e.g. `FICTA_PERSON_…`, `FICTA_SSN_…`) instead of the opaque `FICTA_<hex>`, preserving the model's grammatical/semantic cue for a redacted span while keeping the same keyed-HMAC tail (determinism and reversibility unchanged). The `<TYPE>` is drawn from a fixed category taxonomy (adapted from Presidio's anonymizer entity mapping) with a coarse `SECRET`/`PII` fallback, so an arbitrary label such as a registered secret's env-var name never leaks into the token. The active style is configurable via `[surrogate] style` ↔ `FICTA_SURROGATE_STYLE` (persisted to `~/.ficta/config.toml`), shown on the startup banner and in `ficta doctor`, and documented in `config.toml.example`. Default remains opaque (`FICTA_<hex>`).
- Added an opt-in request-time secret-shape detector for newly pasted secrets that are not present in the exact-value registry. The built-in `secret-shapes` detector redacts high-signal API key/token shapes, JWTs, private keys, credential URLs, AWS credentials, and secret-ish assignments through the same tokenize-on-egress / restore-on-response path as registered values. Web/standalone proxy protection is controlled by `[secret_shapes] enabled` / `FICTA_SECRET_SHAPES_ENABLED`, coding-agent launches remain off unless `[secret_shapes] agents` / `FICTA_SECRET_SHAPES_AGENTS` is enabled (or `FICTA_SECRET_SHAPES_ENABLED` is explicitly set for one run), and `ficta setup`, `ficta doctor`, the startup banner, `/__ficta/status`, the web UI, docs, and example config now expose the new layer.
- Added a source-checkout Presidio dev sidecar path: `pnpm dev` now starts or reuses a local Docker `presidio-analyzer` when the effective env selects `FICTA_PII_BACKEND=presidio`, mounting `packages/ficta/presidio/default_recognizers.za.yaml`. The shipped registry config keeps Presidio's default recognizers, enables `ZA_ID_NUMBER`, and adds a `ZA_COMPANY_REGISTRATION` pattern recognizer for South African company registration numbers.

### Changed

- Path-like token preservation is now **surface-aware**, closing a fail-open where a registered value embedded in a filesystem-path-like token in a request **header** reached the model unredacted and unflagged by the leak gate. Headers now redact such values; the **query string and request body still preserve** path-like tokens, so legitimate path parameters (`?redirect_uri=/a/b`) and agent tool calls (`cd`, `Read`, `Edit`) are not mangled. `FICTA_REDACT_PATHS=1` still forces redaction on every surface, and `ficta doctor` reports the per-surface posture.
- Set `https://ficta.sh` as the published package homepage and public project overview URL.
- Moved internal architecture, positioning, and remediation notes out of the public tracked docs surface, and removed public links to those notes from the README and threat-model docs.
- Corrected the ficta.sh wire demo and design reference so provider auth headers are shown as pass-through while protected payload values are tokenized.
- Tightened the gateway threat-model and ficta.sh copy so self-hosted data-minimization claims apply to registered values and detected spans, not to the full prompt.
- Highlighted the sensitive-data gateway's South African Presidio recognizer support on ficta.sh, including ZA ID and company registration numbers.
- Renamed the self-hosted web product to Ficta Gateway, split setup docs into `ficta` CLI/proxy and Ficta Gateway paths, added gateway deployment cautions for non-production defaults, and fixed the gateway `.env.example` WorkOS redirect placeholder.
- Repositioned the public README docs so Ficta leads as the open-source engine/CLI/local redaction proxy, while Ficta Gateway is documented as the self-hosted private chat gateway and operator path.
- Moved the published npm package and private workspace package names to the `@serovaai` scope, updated GitHub/npm release plumbing, and removed the legacy prerelease channel from package metadata, install commands, and support/status wording.
- Renamed the public website workspace to `apps/web` / `@serovaai/ficta-web`, including root scripts and deployment metadata.
- Rendered the Ficta Gateway sidebar title as a bracketed text wordmark, using `[ficta]` when unnamed and `[Instance Name]` when a custom instance name is set.

### Fixed

- Warmed the Ficta Gateway workspace switcher before the account menu opens, avoiding the delayed first render of workspace options.
- Made source-checkout agent shims recover from a moved local ficta checkout by honoring `FICTA_CLI_PATH`, conservatively discovering a valid moved checkout from the current repository tree, and printing non-global repair guidance when recovery is not possible.
- Committed the TanStack Start generated route tree for ficta.sh so clean CI checkouts can typecheck the web app.
- Suppressed default startup diagnostics and shutdown stats for machine-readable wrapped-agent commands such as `claude -p --output-format json` and `codex exec --json`, keeping automation stderr clean unless `--ficta-verbose` or `FICTA_LOG_LEVEL=debug` is explicitly set.

## 0.1.0-beta.8 - 2026-07-03

### Added

- PII detection is now scoped **per surface**. Launched coding agents (`ficta claude|codex|pi`) keep PII detection **off by default even when `[pii] enabled` is on**, because tokenizing an email inside code you're editing is rarely wanted; re-enable it for agents with the new `[pii] agents` ↔ `FICTA_PII_AGENTS` (default off). The web/standalone proxy is unchanged — it still follows `[pii] enabled`. An explicit shell `FICTA_PII_ENABLED` still wins for a single agent run (the documented escape hatch); otherwise an agent gets PII only when both `[pii] enabled` and `[pii] agents` are true. `ficta setup` now asks a second, default-no prompt for agent-launch PII, the startup banner shows a `pii: on/off` line for the session, and `ficta doctor` reports both surfaces. See `docs/plugins.md`.
- Made the PII detection backend selectable and added a Microsoft Presidio backend. The active backend is chosen via `FICTA_PII_BACKEND` ↔ `[pii] backend` (default `regex`, so existing behavior is unchanged) — a registry of backends with exactly one selected at a time. The new `presidio` backend plugs in behind the existing `PiiRecognizer` seam and calls a `presidio-analyzer` REST sidecar (`POST /analyze`) for each request body — header/query surfaces stay regex-based — mapping detected spans to the same tokenize-on-egress / restore-on-response path as any protected value, with an entity allowlist, score threshold, minimum length guard, and correct code-point offset handling. You run the sidecar (e.g. via Docker) and point ficta at it with `[pii.presidio] url` (`FICTA_PII_PRESIDIO_URL`, default `http://127.0.0.1:5002`); language, score threshold, entity allowlist, and timeout are configurable. See `docs/plugins.md`.
- `ficta setup` now prompts for the PII backend (and, for Presidio, the URL and the fail-closed choice) when PII detection is enabled, persisting `[pii] backend`, `[pii.presidio] url`, and `[pii] fail_closed`.
- `ficta doctor` now probes the Presidio sidecar's `/health` when `presidio` is the selected PII backend and warns if it is unreachable, and warns about an unknown configured backend name.
- Added a configurable, **core-enforced** detector failure policy. When a detector backend can't run (e.g. the Presidio sidecar is down), the decision to fail-open (skip detection and forward) or fail-closed (block with a `503 ficta_blocked`) is resolved as _per-detector override ?? global default_: a global `[detection] fail_closed` ↔ `FICTA_FAIL_CLOSED_DETECTION` (default off) applies to all detectors, and `[pii] fail_closed` ↔ `FICTA_PII_FAIL_CLOSED` overrides it for PII (unset = defer to the global). The detector only _signals_ the outage (a new `DetectorPlugin.failClosed()` exposes config); the engine resolves the policy and the transport returns the 503 — plugins never enforce. Independent of the global `FICTA_FAIL_CLOSED`, which guards registered-secret leaks (different condition, default on).
- Added a safe proxy `/__ficta/status` endpoint plus internal web-chat badge/banner polling so Presidio outages are visible in the UI, including whether the active detector policy is fail-open (forwarding without Presidio screening) or fail-closed (blocking before the model).
- Added text-file attachments to the internal web chat. Supported text files are inlined into the chat request so ficta can redact them, while PDF/DOCX uploads are blocked with a warning to paste the relevant context until local extraction exists.
- Added self-serve WorkOS workspace onboarding and in-app workspace creation so org-less users can create or select an organization without using the WorkOS dashboard.

### Changed

- Updated README artwork to load from the root `assets/` directory and show the registered-secret and PII gateway flows separately.
- Moved the web chat thread sidebar onto TanStack Query and now creates the thread as soon as the first message is sent, so new chats appear in the sidebar immediately instead of waiting for a navigation, reload, or completed response. Starting a new chat now focuses the composer automatically.
- Updated the root, package, and web README docs plus `config.toml.example` to describe the current web UI / PII gateway flow, PII detector backends and per-surface defaults, Presidio as a first-class externally run sidecar backend with Docker examples, Presidio outage posture, web status polling, attachments, WorkOS workspaces, and storage configuration.
- Made the PII detector outage posture more visible without changing the fail-open runtime default (a detector outage stays best-effort-degraded, not a hard block, per `docs/threat-model.md`). `ficta setup` now defaults the Presidio fail-closed prompt to **Yes** — someone who deliberately picks the heavyweight sidecar is the user most likely to want its outages enforced — while still respecting an explicit prior choice and leaving the runtime default (`FICTA_PII_FAIL_CLOSED`/`FICTA_FAIL_CLOSED_DETECTION`) fail-open. The startup banner's `pii:` line now states the resolved posture (`skips on backend outage` vs `blocks on backend outage`). And an unreachable backend now **re-warns every 5 minutes** (carrying the running failure count) instead of warning only once, so a sidecar that stays down keeps surfacing in logs.
- Tightened the internal web chat sidebar and settings UI toward ChatGPT-style proportions. Settings now opens as a compact autosaving chat overlay dialog from the sidebar instead of navigating to a settings page, and duplicate chat/sidebar-owned actions were removed from the top bar.
- Clarified `ficta setup` prompts so each question names its module or registry source, and explained the registry minimum-length filter in plain language.
- Replaced the separate root `dev:doppler` workflow with a `scripts/dev.mjs` wrapper behind `pnpm dev`; it auto-runs `doppler run -- pnpm dev:all` when Doppler is configured, otherwise loads local `.env` files and starts the proxy + web app without Doppler.
- The PII detection backend is now purely exclusive — the selected backend is the only backend, with no cross-backend fallback. If the selected backend can't run, behavior follows the core-enforced detector failure policy (see Added): fail-open skips detection for that request, fail-closed blocks it. The startup banner and `ficta doctor` show the active backend, the resolved failure mode, and the last recorded sidecar failure.
- Consolidated the four ad-hoc verbosity flags into one leveled env var, `FICTA_LOG_LEVEL` (`silent` < `error` < `warn` < `info` < `debug` < `trace`; default `info` standalone, and the agent wrapper sets `silent` so proxy output never garbles the TUI). `trace` is the raw-body tier — it writes real request/response bodies to disk — so, like the old `FICTA_LOG_BODIES`, it is runtime-only and never persisted to `config.toml`. `ficta doctor` reports the active level and still warns when `trace` is set. This is a clean break with no compatibility aliases:

  | Removed                                       | Replacement                                                                                                                                    |
  | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
  | `FICTA_SILENT=1`                              | `FICTA_LOG_LEVEL=silent` (the wrapper's default)                                                                                               |
  | `FICTA_QUIET=1` / `[runtime] quiet`           | default `FICTA_LOG_LEVEL=info` — non-model (unknown-wire) request lines now need `debug`                                                       |
  | `FICTA_LOG_BODIES=1` / `[logging] log_bodies` | `FICTA_LOG_LEVEL=trace` (also unmutes the console, so under a wrapped agent it now garbles the TUI — capture bodies with the standalone proxy) |
  | `FICTA_VERBOSE=1`                             | `--ficta-verbose` (startup diagnostics only; proxy logs stay silent) or `FICTA_LOG_LEVEL=debug`                                                |

  Stale `log_bodies` / `quiet` keys in an existing `config.toml` are ignored (they no longer map to anything) and dropped the next time `ficta setup` rewrites the file.

- Proxy runtime logging now runs on **pino** (with **pino-pretty**). All proxy log output — the listening banner, per-request `→`/`←` summaries, `🔒 kept` / `♻️ restored`, and upstream/blocked errors — is emitted as structured records to **stderr** (stdout belongs to the wrapped agent's TUI): colorized and human-readable when stderr is an interactive terminal, newline-delimited JSON when redirected or piped (aggregator-friendly; `pid`/`hostname` omitted). `FICTA_LOG_LEVEL` maps directly onto pino's levels, so the level semantics above are unchanged. Command _results_ — `ficta --version`, `--help`, the `doctor` report, and `install`/`uninstall`/`enable`/`disable` status — stay plain stdout/stderr so scripts and pipes keep working. The compact aligned startup box is replaced by the structured `ficta listening …` record; per-source registry discovery detail (the old `--ficta-verbose` report) now logs at `debug`.

### Fixed

- Added a web chat not-found page so unmatched routes render a branded in-app fallback instead of TanStack Router's generic default.
- Split the web chat markdown renderer out of the initial chat bundle, reducing the main `ChatView` client chunk and loading the richer markdown path only when message text is rendered.
- Made the web chat protection status badge keyboard-focusable and exposed its detailed posture text to assistive technologies instead of making that detail hover-only.
- Improved the web chat's touch ergonomics by giving coarse-pointer devices larger hit areas for buttons, menus, sidebar rows, composer attachment controls, and settings controls while preserving the compact desktop layout.
- Fixed request-time proxy logs appearing inside Claude Code/Pi TUIs in source-checkout launches by making the pino logger initialize lazily after the agent wrapper sets `FICTA_LOG_LEVEL=silent`. `FICTA_LOG_LEVEL` remains the single request-time logging control: leave it unset/`silent` for clean wrapped-agent TUIs, or explicitly set `info`/`debug`/`trace` for terminal proxy logs while debugging. The shutdown stats summary is also suppressed for default interactive launches.

## 0.1.0-beta.7 - 2026-07-01

### Added

- Added opt-in, best-effort PII detection. A new built-in `pii` detector plugin redacts structured PII — email addresses, US SSNs, and Luhn-validated card numbers — through the same tokenize-on-egress / restore-on-response path as registered secrets. It is off by default for an unconfigured proxy (enable with `FICTA_PII_ENABLED=1` or `pii.enabled`; `ficta setup` now defaults it on — see below), and detection backends are pluggable behind a new exported `PiiRecognizer` contract so an out-of-process NER/Presidio recognizer can be added later. Detection is best-effort — a reduction, not the exact-match guarantee registered values receive.
- Made PII detection request-scoped. Each request opens an ephemeral vault layer over the shared permanent (registered-secret) layer via a new `RedactionEngine.beginRequest(scopeKey?)` seam; values detected while redacting a request are tokenized and restored only for that request, then discarded when the handler returns. This bounds detected-value memory and closes a cross-client leak (one client's detected PII can never be restored into another's response, since detected surrogates are private to the scope). `scopeKey` is the reserved seam for a future persistent session/org vault; ignored today.
- Added a restore-count log line symmetric with the egress line: responses log `♻️ ficta #N — restored M value(s) in response` alongside `🔒 ficta #N — kept N body value(s)`, so the round-trip is visible from the console. The count spans buffered and streaming restore and is suppressed when zero.

### Changed

- `ficta setup` now defaults PII detection **on**. Standing up the gateway implies wanting detection, so the wizard prompt defaults to yes and names the active recognizer; the "best-effort MVP" caveat applies to the current recognizer's coverage, not the concept. The No path remains for shared-proxy/CLI use where the regex could tokenize an email in agent code, and `FICTA_PII_ENABLED=0` is still an explicit force-off. An unconfigured proxy (no `ficta setup`, no env) stays off.
- Detector plugins now report an `active` discovery status instead of a misleading value count. An enabled detector holds no preloaded values — it matches each request at runtime — so the startup banner and `ficta doctor` show `✓ PII detector — active …` rather than `! PII detector (0 values)`, which read as idle.
- Detectors are now first-class config-driven plugins. A `DetectorPlugin` may declare `config`/`setup`/`discover` (previously exclusive to registry sources), so a detector self-gates on its own `enabled` flag and surfaces in `ficta setup`, `config.toml`, and the startup banner; `loadValues` stays registry-source-only. The detection path is also now asynchronous — plugin `detectText` may return a `Promise`, which the engine awaits on the request path — so recognizers can call out of process. Both are exposed through the `@steflsd/ficta/plugins` entry point.
- Restructured the repository into a pnpm workspace: the package moved from the repo root to `packages/ficta`, with the root now a private orchestrator and a new `apps/web` chat UI alongside it. The published `@steflsd/ficta` package is byte-for-byte unchanged (identical tarball). Source-checkout developers must re-run `ficta install` after pulling, because the dev shim's launcher records an absolute path to `bin/ficta.mjs`.

## 0.1.0-beta.6 - 2026-06-30

### Added

- Added local metadata-only protection stats for each proxy run, including a shutdown summary and `stats.json` with counts by model, surface, wire, and protected label.
- Added an opt-in live end-to-end protection check (`pnpm test:e2e`, or `pnpm verify:live`) that launches each real agent (Claude Code, Codex, Pi) through ficta against the real provider, makes it read a sample `.env`, and asserts the canary value is redacted on the wire (placeholder present, literal absent) with the local restore round-trip checked. It is excluded from the default offline suite/CI and self-skips per agent when the real binary or provider auth is absent.

### Changed

- Documented that IDE clients such as Cursor are out of scope: only CLI agents that route all model traffic through the proxy are supported, since Cursor's Agent/Edit/Tab features bypass a custom base URL and could reach the provider unredacted. Recorded the boundary in `docs/threat-model.md` and the README supported-agents section.

### Fixed

- Fixed the Pi adapter, which did not actually route model traffic through ficta. Pi ignores an extension's `registerProvider({ baseUrl })` override (it patches model copies after load and the override never reaches the request layer), so the previous temp-extension approach left Pi talking directly to the real backends — including the user's default `openai-codex` provider. ficta now launches Pi with `PI_CODING_AGENT_DIR` set to an ephemeral agent dir that mirrors the user's real auth/settings and swaps in a generated `models.json` overriding the base URLs of the built-in `anthropic`/`openai`/`openai-codex` providers, the only override Pi reliably honors. Redaction and restore round-trip are verified live for `openai-codex`/`gpt-5.5`; user-defined providers point at their own upstreams and remain unrouted.
- Restored surrogates in streamed SSE responses that arrive with no `content-type` header — notably the ChatGPT/Codex backend (`/backend-api/codex/responses`). Previously the missing content-type made the restore check fail closed-to-passthrough, so `FICTA_…` placeholders leaked into the agent's output instead of the real values. ficta now treats a content-type-less response on a known model wire (anthropic / openai-chat / openai-responses) as that wire's event stream and restores it. This is what let Pi's `openai-codex` path complete its round-trip.

## 0.1.0-beta.5 - 2026-06-30

### Changed

- Clarified README and threat-model wording for registry filters, path-like-token preservation, auth-header pass-through scope, and supported-agent verification status.
- Consolidated boolean env-flag parsing into a single `src/env-flags.ts` (`parseBoolean`/`envFlag`/`envEnabled`) and deduplicated `isRecord`, removing ~7 drifted copies across config, CLI, doctor, vault, user-config, and plugins.
- Routed all fail-closed 403s through a single shared builder so the query/body/header surfaces stay in lockstep, added blocked-leak logging to the query surface, and reduced redundant registry rebuilds during body inspection.
- Routed both the buffered (streaming-JSON and non-streaming) response paths through a single restore-by-content-type helper so the JSON-vs-text restore decision lives in one place.

### Fixed

- Fixed fail-closed leak detection for registered numeric-looking values sent as JSON number primitives; the backstop now matches a value only as a complete primitive token, so a registered number is never falsely flagged when it merely appears as a substring of a larger unrelated number (e.g. `12345678` inside `99912345678`).
- Hardened Doppler registry loading by refusing a Doppler executable file that is itself world-writable.
- Redacted registered secret values that appear percent-encoded in request query strings; the query surface now decodes each parameter to redact and the fail-closed leak check sees the real plaintext, while re-encoding only the parameters it actually changed so untouched, encoding-sensitive parameters keep their wire bytes verbatim.
- Treated only genuine `127.0.0.0/8` dotted-quad literals as loopback when applying the custom-upstream gate; lookalike DNS names such as `127.foo.com` and `127.0.0.1.attacker.example` are no longer mistaken for loopback.
- Honored all truthy spellings (`yes`, `on`, `enabled`, …) for boolean env flags consistently; previously `FICTA_REDACT_PATHS=yes` was silently ignored because the vault's parser accepted only `1`/`true`.
- Kept JSON response bodies valid when a restored value contains JSON-special characters (quotes, backslashes, newlines): surrogates are now restored in place with each value escaped for its JSON string context, instead of a `JSON.parse`/`JSON.stringify` round-trip that silently rounded integers beyond 2^53 and reformatted numbers in otherwise-unchanged responses.
- Streamed newline-delimited JSON (`application/x-ndjson`, `application/json-seq`) responses now pass through the streaming restore instead of being buffered in full and run through the single-document JSON restore; only true JSON bodies are buffered.
- Stopped registering shell `PWD`/`OLDPWD` as protected secrets (which redacted the working directory) while keeping every other `PWD`-bearing credential name covered (`DB_PWD`, `ADMINPWD`, `PWDHASH`, …), not only the `_PWD` underscore form.
- Fully restored surrogates in SSE sibling fields and non-fragment event records (JSON-safe) without re-serializing the event, so large integers and number formatting in non-fragment events are preserved.

## 0.1.0-beta.4 - 2026-06-26

- Added a public `./plugins` entry point (`@steflsd/ficta/plugins`) exposing the plugin contract types and built-in plugin API, with TypeScript declaration output (`declaration: true`) so the types ship in the package.
- Pruned dead code surfaced by `knip`: demoted ~26 internal-only symbols from exported to module-private, deleted two genuinely-unused helpers (`pluginsHaveDetectors`, `resetUserConfigForTests`), and removed stale barrel re-exports in `plugins/index.ts` and `log.ts`. `knip` now reports zero findings.
- Added trust-gated registry-policy exclusions: a plugin may declare safe metadata-only env-name exclusions, but core only enforces them for trusted built-ins and applies them at every named-value ingress (registry load, detector output, and caller-supplied values). The built-in Doppler plugin uses this to exclude `DOPPLER_CONFIG`/`DOPPLER_ENVIRONMENT`/`DOPPLER_PROJECT` metadata while `DOPPLER_TOKEN` stays protected by the secret-ish heuristic. The startup banner and `ficta doctor` now report enforced exclusions per source (e.g. `process env 95 (3 excluded)`) and account for them separately from dedupe in the loaded-vs-protected count; the verbose banner lists only enforced rules while `ficta doctor` also shows declared-but-untrusted ones. Policy validation rejects unknown fields and invalid env-name identifiers.

## 0.1.0-beta.3 - 2026-06-25

- Updated Hono to 4.12.27 and Biome to 2.5.1.
- Fixed streamed SSE restore when supported provider deltas split a `FICTA_...` surrogate across events.
- Fixed GitHub Actions pnpm setup by relying on `packageManager` as the single pinned pnpm version.

## 0.1.0-beta.2 - 2026-06-24

- Hono 2.0.6
- Hardened Doppler registry loading by refusing project-local/world-writable Doppler commands and running the Doppler subprocess with a minimal environment.
- Added custom upstream guardrails: non-default non-loopback upstreams now require `FICTA_ALLOW_CUSTOM_UPSTREAM=1`, and remote custom upstreams must use HTTPS.
- Improved registry-source failure handling so strict registry mode blocks on source errors, env-file read errors are reported per file, and detector plugin exceptions do not take down proxy requests.
- Improved `.env` compatibility for common double-quoted escape sequences such as `\n`.
- Added `FICTA_LOG_MAX_BYTES` to cap response log/inspection buffering.
- Simplified the Doppler setup prompt to global active/all coverage choices while keeping named configs available via manual config/env overrides.
- Added development guidance requiring `CHANGELOG.md` updates for meaningful changes.
- Added `ficta --version` / `ficta version`, showing `+dev` when running from a source checkout.
- Reformatted `ficta --help` into standardized sections with aligned commands and a shorter common environment section.
- Documented `pnpm add -g "$(pwd)"` for source-checkout developers who want a bare local `ficta` command.
- Made setup preselect the Doppler registry source only when Doppler is explicitly enabled or the Doppler CLI is detected on `PATH`.
- Moved registry-source setup/config/default metadata behind an explicit `kind: "registry-source"` plugin contract, with validation that fails non-compliant registry providers.

## 0.1.0-beta.1 - 2026-06-23

- Added `ficta disable` and `ficta enable` to globally bypass/re-enable installed shims without uninstalling.
- Changed shim installation to use a hidden `~/.ficta/bin/.ficta-launcher`, so `~/.ficta/bin` does not shadow the global `ficta` command.
- Documented npm, pnpm, and bun global install commands.
- Added a Pi-style release flow: local release script bumps `package.json`, promotes `CHANGELOG.md`, commits/tags, and tag-triggered GitHub Actions publishes to npm with provenance.

## 0.1.0-beta.0

Initial npm beta release.

- Local redaction proxy for Claude Code, Codex, and Pi.
- Registry-source support for `.env`, process environment, and Doppler-managed values.
- Deterministic surrogate replacement, local restore, and fail-closed outbound leak checks for registered values.
- CLI setup, doctor, install, uninstall, and per-agent launch commands.
