# Ficta frontend control-plane contract

Ficta exposes a small, versioned HTTP control plane for user interfaces and operator tools. The
canonical machine-readable contract is the oRPC router and generated OpenAPI 3.1.1 document in
`@serovaai/ficta-contract`. A frontend can use the supplied TypeScript client, generate a client from
OpenAPI, or implement the HTTP calls directly.

## Boundary

The contract covers discovery, process health, values-free protection status, and pre-send
protection preview. It does **not** redefine provider traffic: OpenAI and Anthropic requests continue
through Ficta on their native paths and wire formats. This keeps existing SDK streaming, tool calls,
and provider compatibility independent from the frontend contract.

The default base URL is `http://127.0.0.1:8787`. Ficta's control endpoints do not provide user
authentication. The standalone proxy is intended to remain loopback-bound, and protection preview
rejects non-loopback callers. In a multi-user product, terminate user authentication in the
frontend's trusted server and have that server call Ficta. The server—not browser input—owns the
`x-ficta-scope` value used to isolate users and threads.

## Compatibility handshake

Call `GET /__ficta/capabilities` before depending on optional procedures:

```json
{
  "ok": true,
  "service": "ficta",
  "protocolVersion": 1,
  "capabilities": ["health", "status", "protection-preview"]
}
```

`protocolVersion` changes only for a breaking wire-contract revision. Capability names may be added
without changing that version; clients should require the capabilities they use and ignore names
they do not recognize.

## Procedures

| oRPC procedure      | HTTP route                         | Input                                                            | Success output                         |
| ------------------- | ---------------------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| `capabilities`      | `GET /__ficta/capabilities`        | none                                                             | version and supported capability names |
| `health`            | `GET /__ficta/health`              | none                                                             | `{ ok: true, service: "ficta" }`       |
| `status`            | `GET /__ficta/status`              | none                                                             | values-free protection posture         |
| `protectionPreview` | `POST /__ficta/protection-preview` | `{ text: string, protectedValues?: string[] }` plus scope header | redacted preview and send ticket       |

The complete field schemas, limits, optional compatibility fields, and response examples are in the
[generated OpenAPI document](https://github.com/SerovaAI/ficta/blob/main/packages/contract/openapi/ficta-control-plane.openapi.json).
Existing `@serovaai/ficta-protocol` guards remain useful when a JavaScript integration wants an
additional runtime check at a trust boundary.

Preview `text` is limited to 2,097,152 bytes after UTF-8 encoding. Its OpenAPI schema publishes this
as `x-ficta-max-utf8-bytes`; clients must enforce that byte limit rather than relying only on the
coarser standard `maxLength` character ceiling.

## TypeScript client

```ts
import {
  createFictaControlClient,
  FICTA_SCOPE_HEADER,
  fictaControlErrorData,
  fictaControlErrorStatus,
} from "@serovaai/ficta-contract";

const client = createFictaControlClient({ baseUrl: "http://127.0.0.1:8787" });
const status = await client.status();

const scopedClient = createFictaControlClient({
  baseUrl: "http://127.0.0.1:8787",
  headers: { [FICTA_SCOPE_HEADER]: trustedThreadScope },
});

try {
  const preview = await scopedClient.protectionPreview({ text, protectedValues });
  // Store preview.ticket only long enough to perform the reviewed send.
} catch (error) {
  const httpStatus = fictaControlErrorStatus(error);
  const response = fictaControlErrorData(error);
  console.error(httpStatus, response?.message);
}
```

The client uses oRPC's OpenAPI transport. `baseUrl` may be a string or `URL`; static request headers
and a custom `fetch` implementation are optional.

## Protection preview and send

Preview is a trusted, loopback-only preparation step:

1. Assign an opaque, server-owned scope for the authenticated organization, user, and thread.
2. Send the current message text and any user-selected protected values to
   `POST /__ficta/protection-preview` with `x-ficta-scope`.
3. Render `redactedText` and `findings`. Finding offsets are UTF-16 coordinates into the exact input
   text, matching JavaScript string indexing.
4. If the user sends that reviewed message, include the returned ticket as
   `x-ficta-protection-ticket` on the native provider request and repeat the same `x-ficta-scope`.

The ticket is opaque, short-lived, scoped, bound to the final user-message hash, and consumed once.
It is never forwarded upstream. Previewing is not sending: if text or scope changes, request a new
preview. A client must handle `409 ficta_protection_preview_stale` from the provider request by
previewing again.

## Error contract

Preview errors preserve the established HTTP body while the supplied client exposes them as typed
oRPC errors:

```json
{
  "ok": false,
  "service": "ficta",
  "status": "invalid_request",
  "message": "A trusted scope is required."
}
```

| `status`               | HTTP | Meaning                                             |
| ---------------------- | ---- | --------------------------------------------------- |
| `invalid_request`      | 400  | body, limits, or trusted scope are invalid          |
| `forbidden`            | 403  | preview caller is not loopback                      |
| `invariant`            | 422  | Ficta blocked a preview that could not be made safe |
| `detector_unavailable` | 503  | a required request-time detector could not run      |

Do not put protected text or values into error metadata, logs, analytics, or exception messages.

## Implementing another engine or frontend

An alternative engine implementation conforms when it serves the documented methods and paths,
validates inputs, returns the OpenAPI response shapes and status codes, isolates trusted scopes, and
implements the ticket properties above. An alternative frontend should treat discovery and status
as values-free, keep protected values on the trusted local/server boundary, and pass native provider
traffic through without translating it into the control protocol.

The repository's contract and proxy conformance tests cover route discovery, typed-client calls,
legacy HTTP errors, method isolation, scope handling, and ticket behavior. Run them with:

```sh
pnpm --filter @serovaai/ficta-contract check
pnpm --filter @serovaai/ficta test
```
