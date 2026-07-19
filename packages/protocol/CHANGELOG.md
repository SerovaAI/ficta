# @serovaai/ficta-protocol

## 0.2.1

## 0.2.0

### Minor Changes

- [#60](https://github.com/SerovaAI/ficta/pull/60) [`083e548`](https://github.com/SerovaAI/ficta/commit/083e5488d8a518b1e9e70ed1dd5b7f25221c15d5) Thanks [@steflsd](https://github.com/steflsd)! - Enable context-bound entity-family surrogates for structured entities in trusted keyed request bodies and document their metadata boundary.

- [`2dbfc1a`](https://github.com/SerovaAI/ficta/commit/2dbfc1ac2b91f36d324a9c8c307c3a3e5223e9bd) Thanks [@steflsd](https://github.com/steflsd)! - Add live managed-registry reloads and Markdown-aware PII case coverage.

- [#40](https://github.com/SerovaAI/ficta/pull/40) [`726f504`](https://github.com/SerovaAI/ficta/commit/726f50408683fd05fc178aab6b89b2f189b00111) Thanks [@steflsd](https://github.com/steflsd)! - Enforce strict managed-registry contracts and separate engine, proxy, protocol, and Gateway responsibilities.

- [#58](https://github.com/SerovaAI/ficta/pull/58) [`b6c2cdf`](https://github.com/SerovaAI/ficta/commit/b6c2cdf913237bc3a36f28492feff37e1a06e6c2) Thanks [@steflsd](https://github.com/steflsd)! - Link unique high-confidence organization aliases to registered entity anchors and report values-free ambiguity counts in protection stats and egress proofs.

- [`7c8272c`](https://github.com/SerovaAI/ficta/commit/7c8272cd293c11ab31b4ab1e9633c2cbe44862c6) Thanks [@steflsd](https://github.com/steflsd)! - Standardize validation commands on `check`, replacing the `verify` and `verify:*` scripts.

- [#59](https://github.com/SerovaAI/ficta/pull/59) [`9031dad`](https://github.com/SerovaAI/ficta/commit/9031dad8aebeff406eda86aeca5074d8b8f0a730) Thanks [@steflsd](https://github.com/steflsd)! - Add gated context-bound entity-family surrogate rendering and exact restoration across buffered, streaming, and tool-call transports.

- [#56](https://github.com/SerovaAI/ficta/pull/56) [`e465e5a`](https://github.com/SerovaAI/ficta/commit/e465e5adb883f2ff93a17e0acf3cc7c87ec5f085) Thanks [@steflsd](https://github.com/steflsd)! - Introduce the entity-aware managed registry v1 contract with explicit form boundaries, strict whole-registry validation, and restart-safe live reloads.

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

- [#41](https://github.com/SerovaAI/ficta/pull/41) [`1bd5178`](https://github.com/SerovaAI/ficta/commit/1bd517801a7aefcbf265e8f95cd090e50f4fc8fb) Thanks [@steflsd](https://github.com/steflsd)! - Allow attachment-only Gateway drafts to enter protection review or send with the existing generic review instruction.

- [`737e967`](https://github.com/SerovaAI/ficta/commit/737e9678f42b1febb1b20cfb4f9be91a162bbaae) Thanks [@steflsd](https://github.com/steflsd)! - Consolidate CI, secret scanning, and release automation into one gated workflow run.

- [`af9dea2`](https://github.com/SerovaAI/ficta/commit/af9dea2cd48bef947e15e97d7160520805a9f175) Thanks [@steflsd](https://github.com/steflsd)! - Document routing `ficta claude` through a local Anthropic-compatible proxy via `FICTA_ANTHROPIC_UPSTREAM`, so an alt model (e.g. GPT‑5.6 "sol" behind CLIProxyAPI on a ChatGPT subscription) can run with redaction intact. Loopback upstreams need no `FICTA_ALLOW_CUSTOM_UPSTREAM`.

- [`f3cbc49`](https://github.com/SerovaAI/ficta/commit/f3cbc4949d9bc28f622a187e5c251d2b1a1f8cdd) Thanks [@steflsd](https://github.com/steflsd)! - Live protected registry: values published from the gateway admin UI take effect in the running proxy without a restart. New `POST /__ficta/registry/reload` (loopback-gated, request body ignored, counts-only response including `skippedTooShort` for values below `FICTA_REGISTRY_MIN_LEN`), `ProtectionEngine.reloadRegistryValues()` registering new managed-file values into the live vault, and a stat-based cache key for the managed-registry plugin (a rewritten file is actually re-read — also fixes stale registry counts in per-request log metadata and `ficta doctor`). Additions are live; deletions still apply on restart (removing a value mid-process would break restore of surrogates already in transcripts). Protocol gains `FICTA_REGISTRY_RELOAD_PATH`, `RegistryReloadOk/Error`, and `isRegistryReloadOk`.

- [#34](https://github.com/SerovaAI/ficta/pull/34) [`50a49f7`](https://github.com/SerovaAI/ficta/commit/50a49f7be1e9d5457ff22b5f91d83ff9187d3c74) Thanks [@steflsd](https://github.com/steflsd)! - Add a gateway trace-capture header so raw proxy trace/audit capture can be scoped per chat thread.

- [`2d55f15`](https://github.com/SerovaAI/ficta/commit/2d55f15723805a49acbb82c6bce94ad6670cd22f) Thanks [@steflsd](https://github.com/steflsd)! - Add a loopback-only pre-send protection preview with resolver-authored spans and content-bound, single-use tickets for user-selected chat protections.

- [`f195c54`](https://github.com/SerovaAI/ficta/commit/f195c54bb903e069315f071a7c0d4244028065ba) Thanks [@steflsd](https://github.com/steflsd)! - Record fail-closed detector outages across body, query, and header surfaces as explicit values-free blocked-request proof events.

- [`aacf45d`](https://github.com/SerovaAI/ficta/commit/aacf45da59635a71f1bc93eb2eaa798851cfeb21) Thanks [@steflsd](https://github.com/steflsd)! - Keep published documentation focused on shipped behavior and public threat-model boundaries, with private strategy and future-roadmap material maintained separately.

- [`89da819`](https://github.com/SerovaAI/ficta/commit/89da8193c2d0ff8cec4577f171d9ec46a54b1b05) Thanks [@steflsd](https://github.com/steflsd)! - Enforce required-registry readiness on standalone provider traffic and expose the blocking state to Gateway.

- [#66](https://github.com/SerovaAI/ficta/pull/66) [`efe1203`](https://github.com/SerovaAI/ficta/commit/efe120308145ae9e1213fa235bdb407cdd495865) Thanks [@steflsd](https://github.com/steflsd)! - Observe residual surrogate tokens that survive restore. A surrogate-shaped token with no dictionary mapping — mutated, truncated, or invented by the model (e.g. a wildcard entity-family reference like `FICTA_ORG_<entityTag>_*`) — is now counted per response and surfaced as a values-free total in the proxy log (`⚠️ N unrestored surrogate token(s)`), `protection-stats.json`, and the stats summary. Detection covers opaque, typed, and entity-family token shapes plus entity-family prefix fragments, across buffered, streamed, and SSE restore paths. Observe-only: response bytes are unchanged, and restore remains exact-match — unknown tokens are never fuzzily recovered.

- [#47](https://github.com/SerovaAI/ficta/pull/47) [`2f799b0`](https://github.com/SerovaAI/ficta/commit/2f799b08760c6a02532f09a26e4c997908b0f14e) Thanks [@steflsd](https://github.com/steflsd)! - Highlight locally restored response values without requiring sensitive trace capture.

- [`8c09e18`](https://github.com/SerovaAI/ficta/commit/8c09e18ada996917759f630f4a8a85b87d3cbb69) Thanks [@steflsd](https://github.com/steflsd)! - Add values-free, per-thread provider-egress evidence for Gateway chats.

- [`89da819`](https://github.com/SerovaAI/ficta/commit/89da8193c2d0ff8cec4577f171d9ec46a54b1b05) Thanks [@steflsd](https://github.com/steflsd)! - Simplify the documented POC configuration and have setup emit only the canonical multi-backend PII setting.

- [`2dbfc1a`](https://github.com/SerovaAI/ficta/commit/2dbfc1ac2b91f36d324a9c8c307c3a3e5223e9bd) Thanks [@steflsd](https://github.com/steflsd)! - Harden live Protected Registry publication: Gateway now writes private registry files atomically, serializes publish transactions, and verifies a per-generation revision echoed by the proxy together with managed-source health counts. Hosted Gateway deployments are explicitly bound to one WorkOS organization via `FICTA_GATEWAY_ORG_ID`, matching the proxy's process-global permanent registry.

## 0.1.3

### Patch Changes

- [#18](https://github.com/SerovaAI/ficta/pull/18) [`6e5ff5e`](https://github.com/SerovaAI/ficta/commit/6e5ff5e33e56ee7c4a8010d6d1e218caf90b2c6a) Thanks [@steflsd](https://github.com/steflsd)! - Add restore-highlight surrogate metadata for Gateway privacy display toggles and keep streamed marker output from being restored twice.

- [#20](https://github.com/SerovaAI/ficta/pull/20) [`bac69df`](https://github.com/SerovaAI/ficta/commit/bac69df7879228a70a2573b1f436be39f5adc7b8) Thanks [@steflsd](https://github.com/steflsd)! - Add shared proxy/Gateway contracts for scope headers, protection stats, and trace-audit posture.

## 0.1.2

## 0.1.1 - 2026-07-08

Released in lockstep with `@serovaai/ficta` 0.1.1. This package always versions together with `@serovaai/ficta`.

## 0.1.0 - 2026-07-06

Initial release: dependency-free proxy / Gateway control-plane wire contracts, split out of `@serovaai/ficta`.
