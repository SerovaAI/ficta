# @serovaai/ficta-contract

Language-neutral HTTP contract for building a frontend or operator integration for the Ficta
protection engine. The package includes a generated OpenAPI 3.1.1 document; TypeScript users also get
the source oRPC contract and Zod schemas, a fetch-based client, and shared error decoding.

This package covers the Ficta **control plane** only. OpenAI- and Anthropic-compatible model traffic
continues to use the providers' native wire formats through the proxy and is intentionally not
wrapped in oRPC.

## Start here

Choose the smallest integration profile your product needs:

| Profile               | Interface                                                      |
| --------------------- | -------------------------------------------------------------- |
| Transparent proxy     | Send native Anthropic or OpenAI HTTP/SSE traffic through Ficta |
| Status-aware frontend | Discover capabilities, then read values-free protection status |
| Reviewed send         | Preview exact text, render findings, then make one bound send  |
| Operator liveness     | Probe control-plane health with `GET` or `HEAD`                |

The [frontend integration contract](https://github.com/SerovaAI/ficta/blob/main/packages/ficta/docs/control-plane.md)
defines compatibility, deployment and trust boundaries, native provider paths, scope isolation,
the reviewed-send lifecycle, errors, and conformance requirements. Read it alongside OpenAPI: the
schema defines control-plane wire shapes, while the guide defines behavior that OpenAPI cannot
express.

## Install

```sh
pnpm add @serovaai/ficta-contract
```

## Typed client

```ts
import { createFictaControlClient, FICTA_SCOPE_HEADER } from "@serovaai/ficta-contract";

const client = createFictaControlClient({ baseUrl: "http://127.0.0.1:8787" });

const capabilities = await client.capabilities();
const health = await client.health();
const status = await client.status();

const scopedClient = createFictaControlClient({
  baseUrl: "http://127.0.0.1:8787",
  headers: { [FICTA_SCOPE_HEADER]: "my-workspace:my-user:my-thread" },
});
const preview = await scopedClient.protectionPreview({
  text: "Review Project Juniper",
  protectedValues: ["Project Juniper"],
});
```

The proxy defaults to loopback and protection preview is loopback-only. A browser frontend should
normally call its own trusted server, which then calls Ficta; do not expose the proxy or manufacture
trusted scope headers from an untrusted browser.

## Machine-readable OpenAPI

The generated specification is exported as `@serovaai/ficta-contract/openapi.json` and is also
included at `openapi/ficta-control-plane.openapi.json` in the package. It is generated from the same
oRPC contract used by the client and proxy implementation. Any OpenAPI 3.1-capable language or HTTP
client can use it; oRPC is optional.

The versioned capability response is the runtime compatibility handshake:

```json
{
  "ok": true,
  "service": "ficta",
  "protocolVersion": 1,
  "capabilities": ["health", "status", "protection-preview"]
}
```

Capability names are open for compatible extension. Clients must require the names they use and
ignore unrecognized names when `protocolVersion` remains compatible.

## License

MIT — see [`LICENSE`](./LICENSE).
