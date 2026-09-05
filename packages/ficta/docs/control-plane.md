# Ficta frontend integration contract

This document is the normative behavioral contract for integrating a frontend, operator tool, or
provider client with Ficta. It is intentionally language- and framework-neutral. TypeScript users
may use `@serovaai/ficta-contract`; other clients may generate code from OpenAPI or issue the HTTP
requests directly.

The terms **MUST**, **SHOULD**, and **MAY** describe required, recommended, and optional behavior for
a conforming integration.

## Contract sources and precedence

| Source                                                                                                                  | Normative for                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [OpenAPI 3.1.1](https://github.com/SerovaAI/ficta/blob/main/packages/contract/openapi/ficta-control-plane.openapi.json) | Control paths, methods, request and response shapes, HTTP statuses, and machine-readable limits |
| This document                                                                                                           | Trust boundaries, compatibility, scope isolation, preview-ticket lifecycle, and recovery        |
| The upstream provider's API documentation                                                                               | Native Anthropic and OpenAI request, response, streaming, and tool-call formats                 |
| [`@serovaai/ficta-contract`](https://www.npmjs.com/package/@serovaai/ficta-contract) and repository examples            | Convenience APIs and non-normative examples                                                     |

If the OpenAPI document and this guide disagree about a control-plane wire shape, OpenAPI wins. If
a behavior is not expressible in OpenAPI, this guide wins. Provider traffic is not redefined by the
Ficta control contract.

## Integration profiles

An integration implements only the profiles it needs. Advertised capability names determine which
optional control procedures are available.

| Profile               | Required interaction                                   | Typical use                                                         |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| Transparent proxy     | Native provider request through Ficta                  | Existing SDK or agent needing protection without a review UI        |
| Status-aware frontend | `capabilities`, then `status`                          | Protection posture, readiness messaging, and send gating            |
| Reviewed send         | `capabilities`, `protection-preview`, then native send | Show findings and bind user-selected values to one outbound message |
| Operator liveness     | `health` using `GET` or `HEAD`                         | Process monitoring and local orchestration                          |

`health` is liveness only. A successful `status` call already proves liveness, so a frontend SHOULD
not call `health` before every `status` or preview request.

## Boundary and deployment

The control plane covers discovery, process health, values-free protection status, and trusted
pre-send review. OpenAI- and Anthropic-compatible model traffic continues through Ficta on native
paths and wire formats. This preserves provider SDK behavior, streaming, and tool calls.

The default Ficta origin is `http://127.0.0.1:8787`. Control endpoints do not authenticate users.
The standalone proxy is intended to remain loopback-bound, and protection preview rejects
non-loopback callers.

A multi-user frontend MUST terminate user authentication in its own trusted server and have that
server call Ficta. A browser SHOULD call the frontend's server, not Ficta directly. The trusted
server—not browser input—owns the `x-ficta-scope` header and provider credentials.

## Compatibility and discovery

Before using an optional control procedure, call `GET /__ficta/capabilities`:

```json
{
  "ok": true,
  "service": "ficta",
  "protocolVersion": 1,
  "capabilities": ["health", "status", "protection-preview"]
}
```

A version-1 client:

- MUST require `protocolVersion` to equal `1`;
- MUST require every capability it plans to call;
- MUST ignore capability names it does not recognize;
- MAY cache a successful discovery response briefly; and
- MUST treat a missing, malformed, or incompatible discovery response as an incompatible proxy, not
  as confirmation that protection is active.

`protocolVersion` changes for a breaking wire-contract revision. Capability names may be added
without changing it. Other version-1 response objects are closed (`additionalProperties: false`):
unknown response fields are not currently a version-1 compatibility mechanism. Adding a required
field, changing a field's type or meaning, or otherwise invalidating a version-1 response requires a
new protocol version.

Package semver and `protocolVersion` serve different purposes. Package releases may improve clients,
documentation, or implementation while retaining protocol version 1. Runtime compatibility MUST be
negotiated with the discovery response, not inferred from an npm version.

## Control-plane procedures

| oRPC procedure      | HTTP route                         | Input                                           | Success output                                |
| ------------------- | ---------------------------------- | ----------------------------------------------- | --------------------------------------------- |
| `capabilities`      | `GET /__ficta/capabilities`        | none                                            | Protocol version and capability names         |
| `health`            | `GET` or `HEAD /__ficta/health`    | none                                            | Liveness JSON for `GET`; no body for `HEAD`   |
| `status`            | `GET` or `HEAD /__ficta/status`    | none                                            | Protection posture for `GET`; none for `HEAD` |
| `protectionPreview` | `POST /__ficta/protection-preview` | `{ text, protectedValues? }` plus trusted scope | Redacted preview, findings, and ticket        |

The supplied oRPC client exposes the JSON-returning `GET` procedures. `HEAD` is available to generic
HTTP monitoring clients and is represented separately in OpenAPI.

### Interpreting status

Status contains counts, configuration, and health metadata only; it never contains registered or
detected values.

| Field or state                                   | Client behavior                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `protection.protecting: false`                   | Do not claim the current proxy is actively protecting data                     |
| `registry.required: true` and status not `ready` | Pause provider sends and show `registry.message`                               |
| `pii.status: blocking`                           | Expect provider requests requiring that detector to be refused                 |
| `pii.status: degraded`                           | Protection is operating with the values-free limitation described in `message` |
| `activity.withheldFromTools > 0`                 | Surface an operator-visible warning; protected output was withheld from a tool |

Clients SHOULD use the structured state fields for decisions and the accompanying `message` fields
for display. They MUST NOT parse display messages to recover state.

### Preview limits and normalization

- `text` is limited to 2,097,152 bytes after UTF-8 encoding.
- `protectedValues` accepts at most 200 entries.
- Each protected value must be non-empty and at most 2,000 characters; values are trimmed.
- Duplicate protected values are removed while preserving first occurrence order.
- The combined unique protected values are limited to 65,536 bytes after trimming and UTF-8
  encoding.
- Finding `start` and `end` are inclusive/exclusive UTF-16 offsets into the exact submitted `text`,
  matching JavaScript string indexing. Every finding MUST have `end > start`.

OpenAPI's standard `maxLength` is only a character ceiling. The actual byte constraints are exposed
as `x-ficta-max-utf8-bytes`; clients MUST enforce those extensions before sending large inputs.

## Native provider data plane

Ficta is a transforming reverse proxy, not a replacement provider API. Use the provider's normal
request and response types and change only the base URL so traffic reaches Ficta.

| Supported wire          | Stable request path         | Provider SDK base URL      |
| ----------------------- | --------------------------- | -------------------------- |
| Anthropic Messages      | `POST /v1/messages`         | `http://127.0.0.1:8787`    |
| OpenAI Chat Completions | `POST /v1/chat/completions` | `http://127.0.0.1:8787/v1` |
| OpenAI Responses        | `POST /v1/responses`        | `http://127.0.0.1:8787/v1` |

Ficta supports buffered HTTP responses and HTTP server-sent events for these wires. It does not
proxy WebSocket upgrades; a client MUST use HTTP/SSE fallback. Packaged Codex ChatGPT/OAuth routing
is an agent adapter and is not a portable third-party frontend wire contract.

Provider authentication headers remain provider-native. Ficta consumes and strips all internal
`x-ficta-*` headers before forwarding a request upstream. A frontend MUST NOT translate native
provider streaming or tool-call events into the control protocol.

Requests without a protection-preview ticket are valid: Ficta still applies its configured registry
and detectors. The reviewed-send profile is required only when the frontend wants findings,
user-selected protected values, or explicit approval binding.

## Trusted scopes

`x-ficta-scope` selects the persistent detected-value and ticket isolation boundary. A conforming
multi-user frontend:

- MUST derive the scope from authenticated tenant, user, and conversation identity;
- MUST NOT accept a complete scope value from untrusted browser input;
- MUST use the same scope for preview and the corresponding provider send;
- MUST use different scopes for conversations that must not share detected values;
- MUST keep it non-empty and at most 256 characters; and
- SHOULD keep it opaque and free of protected text.

Without a scope, ordinary provider requests receive an isolated ephemeral request scope. Preview
requires a trusted scope and fails without one.

## Reviewed-send lifecycle

The required state sequence is:

```text
discover capability
        │
        ▼
preview exact text ──▶ render redactedText/findings ──▶ native provider send
        ▲                                                    │
        └──────────────────── 409 stale ─────────────────────┘
```

1. Assign a trusted scope for the authenticated tenant, user, and conversation.
2. Send the exact current message and any user-selected values to
   `POST /__ficta/protection-preview` with `x-ficta-scope`.
3. Render `redactedText` and `findings`. Previewing does not contact the provider.
4. If the user sends the reviewed message, make the normal provider request with the same
   `x-ficta-scope` and the returned ticket in `x-ficta-protection-ticket`.
5. On `409 ficta_protection_preview_stale`, discard the ticket, preview the current text again, and
   require review again when the product's review policy calls for it.

A ticket is an opaque, non-empty printable ASCII HTTP header value without whitespace. It is short-lived, scoped, bound to the SHA-256 of the preview text, and consumed once.
Clients MUST NOT inspect it, persist it as conversation state, reuse it, or depend on a particular
expiry duration. A client MUST treat a ticket as spent once it attaches the ticket to an attempted
send; a failure is not a promise that the ticket remains usable. After the request body and ticket
binding are accepted, Ficta atomically consumes the ticket before body detection or upstream I/O.

For JSON provider requests, ticket binding accepts these message shapes:

- `input` as the exact preview string;
- `input` or `messages` as an array whose last `role: "user"` message contains the exact preview
  string; and
- user content as a string or an array part with a string `text` or `content` field.

For a non-JSON body, the complete body must match the preview text. A changed scope, changed text,
missing request body, expired ticket, or replayed ticket produces `409` and is never forwarded.

## Language-neutral HTTP example

Discover the protocol:

```sh
curl --fail-with-body http://127.0.0.1:8787/__ficta/capabilities
```

Preview one exact message from a trusted server:

```sh
curl --fail-with-body \
  --request POST \
  --header 'content-type: application/json' \
  --header 'x-ficta-scope: workspace-7:user-42:thread-9' \
  --data '{"text":"Review Project Juniper","protectedValues":["Project Juniper"]}' \
  http://127.0.0.1:8787/__ficta/protection-preview
```

An illustrative response is below. Ticket and surrogate values vary; `textSha256` is the real digest
of the example text and can be used as a test vector.

```json
{
  "ok": true,
  "service": "ficta",
  "ticket": "opaque-value",
  "textSha256": "b788b189eab44ecd34ebb281e093cf2cb32d835b9f9fbc4a3e1b530b962694e7",
  "redactedText": "Review [opaque surrogate]",
  "findings": [
    {
      "name": "USER_SELECTED",
      "source": "user-selected",
      "kind": "custom",
      "confidence": "exact",
      "start": 7,
      "end": 22,
      "surrogate": "[opaque surrogate]",
      "origin": "user"
    }
  ]
}
```

Send the unchanged text using the provider's native OpenAI Responses shape:

```sh
curl --no-buffer --fail-with-body \
  --request POST \
  --header 'authorization: Bearer provider-key' \
  --header 'content-type: application/json' \
  --header 'x-ficta-scope: workspace-7:user-42:thread-9' \
  --header 'x-ficta-protection-ticket: opaque-value' \
  --data '{"model":"provider-model","input":[{"role":"user","content":[{"type":"input_text","text":"Review Project Juniper"}]}],"stream":true}' \
  http://127.0.0.1:8787/v1/responses
```

The ticket and scope headers stop at Ficta. The provider receives the protected representation, and
the client receives the provider's native response with eligible surrogates restored locally.

## TypeScript client

```ts
import {
  createFictaControlClient,
  FICTA_SCOPE_HEADER,
  fictaControlErrorData,
  fictaControlErrorStatus,
} from "@serovaai/ficta-contract";

const client = createFictaControlClient({ baseUrl: "http://127.0.0.1:8787" });
const discovery = await client.capabilities();
if (discovery.protocolVersion !== 1 || !discovery.capabilities.includes("status")) {
  throw new Error("Incompatible Ficta control plane");
}
const status = await client.status();

const scopedClient = createFictaControlClient({
  baseUrl: "http://127.0.0.1:8787",
  headers: { [FICTA_SCOPE_HEADER]: trustedConversationScope },
});

try {
  const preview = await scopedClient.protectionPreview({ text, protectedValues });
  // Render preview, then attach preview.ticket and the same trusted scope to the native provider send.
} catch (error) {
  console.error(fictaControlErrorStatus(error), fictaControlErrorData(error)?.message);
}
```

The supplied client validates every successful response with the published schemas, including non-empty tickets and finding spans with `end > start`. Legacy `@serovaai/ficta-protocol` guards remain available for older consumers; new integrations SHOULD use the contract schemas or client.

The supplied client uses oRPC's OpenAPI transport. `baseUrl` may be a string or `URL`; static request
headers and a custom `fetch` implementation are optional. oRPC is not required for conformance.

## Error and recovery contract

Preview errors use a stable values-free body:

```json
{
  "ok": false,
  "service": "ficta",
  "status": "invalid_request",
  "message": "A trusted scope is required."
}
```

| Preview status         | HTTP | Required handling                          |
| ---------------------- | ---- | ------------------------------------------ |
| `invalid_request`      | 400  | Correct the body, limits, or trusted scope |
| `forbidden`            | 403  | Move preview behind a trusted local server |
| `invariant`            | 422  | Do not send the unreviewed message         |
| `detector_unavailable` | 503  | Follow product retry/fail-closed policy    |

Common provider-path failures have `{ "error": { "type", "message" } }` bodies:

| HTTP | Error type or class                  | Client behavior                                             |
| ---- | ------------------------------------ | ----------------------------------------------------------- |
| 409  | `ficta_protection_preview_stale`     | Preview the current message again                           |
| 403  | Protection or upstream-policy block  | Do not bypass Ficta; show a safe diagnostic                 |
| 503  | Registry or required-detector outage | Pause or retry according to operator policy                 |
| 413  | Request body too large               | Reduce the provider request                                 |
| 415  | Unsupported or undecodable encoding  | Send a supported HTTP encoding                              |
| 426  | WebSocket unsupported                | Retry over HTTP/SSE                                         |
| 500  | Internal protection invariant        | Do not forward directly; report the failure                 |
| 502  | Upstream connection failure          | Retry as a provider failure; get a new ticket when required |

Protected text and values MUST NOT be placed in errors, logs, analytics, traces, scope strings, or
exception metadata.

## Minimal implementation algorithm

A frontend or coding system can implement the reviewed-send profile with this algorithm:

```text
1. GET capabilities.
2. Require protocolVersion == 1 and the capabilities you will use.
3. GET status; pause sends when a required registry is not ready.
4. Derive a server-owned scope from authenticated conversation identity.
5. POST preview with exact current text and optional protected selections.
6. Validate the response against OpenAPI and render findings using UTF-16 offsets.
7. If the text changes, discard the ticket and return to step 5.
8. Send the native provider request with the same scope and the ticket.
9. On 409, discard the ticket and return to step 5.
10. Never retry a ticket or log protected input.
```

## Conformance checklist

### Frontend

A conforming frontend:

- negotiates protocol and required capabilities at runtime;
- validates control responses and enforces both standard and Ficta byte limits;
- keeps provider credentials, scopes, selected protected values, and preview calls behind a trusted
  boundary;
- uses stable per-conversation scope isolation;
- sends the exact reviewed text on the native provider wire;
- treats tickets as ephemeral and single-use;
- handles `409` by previewing again;
- preserves provider streaming and tool-call formats; and
- never bypasses the proxy after a protection failure.

### Alternative engine

An alternative engine implementation:

- serves the documented control methods, paths, schemas, and statuses;
- advertises only procedures it implements;
- keeps health, discovery, status, and errors free of protected values;
- enforces trusted local preview and scope isolation;
- implements opaque, short-lived, scoped, hash-bound, atomic single-use tickets;
- strips internal Ficta headers before provider forwarding;
- preserves supported native provider request, response, and SSE formats; and
- returns `409` without forwarding when preview authorization is stale or mismatched.

The repository tests exercise the reference implementation's route discovery, generated OpenAPI,
typed client, error bodies, method isolation, scope handling, `HEAD` behavior, and ticket lifecycle:

```sh
pnpm --filter @serovaai/ficta-contract check
pnpm --filter @serovaai/ficta test
```

These commands validate the Ficta implementation in this repository; an alternative engine SHOULD
run equivalent black-box tests against its own deployed base URL.

## Optional evidence and operator interfaces

The following capabilities extend protocol version 1 without requiring a new core profile. Discover
and require each capability before calling its procedures. The shared client and OpenAPI include
all these HTTP interfaces. Missing capabilities mean unavailable features, never evidence that a
request was protected. Gateway requires restore highlighting for chat and egress proof for its
conversation ledger; operator features require their own capabilities when used.

| Capability           | Client procedures                                   | HTTP interface                        |
| -------------------- | --------------------------------------------------- | ------------------------------------- |
| `protection-stats`   | `protectionStats({ limit? })`                       | `GET /__ficta/protection-stats`       |
| `egress-proof`       | `egressProof()`                                     | `GET /__ficta/egress-proof`           |
| `config`             | `config()`, `updateConfig(patch)`                   | `GET`, `PATCH /__ficta/config`        |
| `trace-capture`      | `traceCapture()`, `updateTraceCapture({ enabled })` | `GET`, `PATCH /__ficta/trace-capture` |
| `registry-reload`    | `registryReload()`                                  | `POST /__ficta/registry/reload`       |
| `restore-highlights` | Native provider response extension                  | `x-ficta-restore-highlights: 1`       |

Statistics are process-wide, not tenant-scoped. The event limit defaults to 100 and is capped at
500; events are newest first and totals cover the proxy run. A multi-user server MUST restrict
process-wide statistics and configuration to authorized operators. Core status remains values-free
readiness; it is not evidence for any particular send.

For request evidence, generate a UUID on the trusted server and attach `x-ficta-egress-event` and
`x-ficta-scope` to the provider request. Read proof with those same headers using a scoped client.
Proof reads are loopback-only. Missing headers produce 400, non-loopback callers receive 403, and
missing or expired evidence produces 404. The reference proxy retains proofs for approximately
15 minutes; clients MUST persist receipts they need and MUST NOT interpret a missing receipt as
successful screening. `survivingValues` covers known values only, not undetected sensitive content.

Configuration PATCH, trace GET/PATCH, and registry reload require loopback callers. The application
server MUST enforce operator authorization. Config changes report `restartRequired` and locked
fields; a saved setting does not promise it is active. Trace capture requires the operator's configured
trace capability, the runtime toggle, and per-request `x-ficta-trace-capture: 1`; enabling a toggle
alone does not promise a trace file. Trace data may be sensitive and is not a values-free receipt.

Registry reload accepts no paths or values. Publish the managed file through the operator's trusted
storage workflow, then optionally send `x-ficta-registry-revision`. Verify the response acknowledges
that exact revision. Missing acknowledgement does not prove publication. Changes/removals may need
a restart; inspect `restartRequired`. Engines without reload support MUST omit `registry-reload`.
Operator errors retain `{ ok: false, service: "ficta", status, message, field? }`; the client decodes
these and exposes `fictaOperatorErrorData`. Config locks return 409, disabled/invalid patches 400,
invalid registry content 409, and unavailable reload implementations 501.

### Restore highlight framing

After requiring `restore-highlights`, opt in on the native provider request. Eligible restored text
contains the following framing inside provider text fields (not a separate SSE event):

```text
START surrogate [ORIGIN origin] METADATA restoredText END
```

The exact marker strings are exported by `@serovaai/ficta-contract` and `@serovaai/ficta-protocol`:
`FICTA_RESTORE_HIGHLIGHT_START`, `FICTA_RESTORE_HIGHLIGHT_ORIGIN`,
`FICTA_RESTORE_HIGHLIGHT_METADATA`, and `FICTA_RESTORE_HIGHLIGHT_END`. Each marker is the matching
`FICTA_RESTORE_*` name surrounded by U+001E; METADATA uses `FICTA_RESTORE_SURROGATE`.
Origin is `registry`, `detected`, or `user` when supplied. Treat the surrogate as opaque. Streaming
clients MUST buffer incomplete markers across chunks, display restored text with their chosen
annotation, and remove framing before copy, export, or resending history. These annotations describe
restoration and are not authenticated egress evidence. Clients that do not implement framing MUST
omit the opt-in header; ordinary native provider responses remain unannotated.
