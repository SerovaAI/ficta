# @serovaai/ficta-contract

Portable, typed contract for building a frontend for the Ficta protection engine. It contains the
oRPC contract and Zod schemas, a fetch-based client, shared error decoding, and a generated OpenAPI
3.1.1 document.

This package covers the Ficta **control plane** only. OpenAI- and Anthropic-compatible model traffic
continues to use the providers' native wire formats through the proxy and is intentionally not
wrapped in oRPC.

## Install

```sh
pnpm add @serovaai/ficta-contract
```

## Typed client

```ts
import { createFictaControlClient, FICTA_SCOPE_HEADER } from "@serovaai/ficta-contract";

const client = createFictaControlClient({
  baseUrl: "http://127.0.0.1:8787",
  headers: { [FICTA_SCOPE_HEADER]: "my-workspace:my-user:my-thread" },
});

const capabilities = await client.capabilities();
const health = await client.health();
const status = await client.status();
const preview = await client.protectionPreview({
  text: "Review Project Juniper",
  protectedValues: ["Project Juniper"],
});
```

The proxy defaults to loopback and protection preview is loopback-only. A browser frontend should
normally call its own trusted server, which then calls Ficta; do not expose the proxy or manufacture
trusted scope headers from an untrusted browser.

## OpenAPI

The generated specification is exported as `@serovaai/ficta-contract/openapi.json` and is also
included at `openapi/ficta-control-plane.openapi.json` in the package. It is generated from the same
oRPC contract used by the client and proxy implementation.

The versioned capability response is the runtime compatibility handshake:

```json
{
  "ok": true,
  "service": "ficta",
  "protocolVersion": 1,
  "capabilities": ["health", "status", "protection-preview"]
}
```

For endpoint behavior, trust boundaries, error bodies, and the preview-ticket flow, see the
[control-plane implementor guide](https://github.com/SerovaAI/ficta/blob/main/packages/ficta/docs/control-plane.md).

## License

MIT — see [`LICENSE`](./LICENSE).
