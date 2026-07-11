# Ficta Gateway

Ficta Gateway is the self-hosted private chat gateway for sensitive-data-aware model access. It is a
[TanStack Start](https://tanstack.com/start) app using TanStack AI for bring-your-own-key OpenAI and
Anthropic chat, with every model call routed through the local Ficta proxy before it reaches the
provider.

This README is the Gateway operator guide: local POC setup, auth and storage posture, sidecars,
verification, and production-like deployment cautions. The coding-agent and local proxy path is the
`ficta` CLI; its shim setup lives in [`../../packages/ficta/README.md`](../../packages/ficta/README.md)
and [`../../packages/ficta/docs/install.md`](../../packages/ficta/docs/install.md).

## What It Does

The browser talks to the gateway server, not directly to the model provider:

```txt
browser (useChat)
  -> /api/protection-preview  detect + preview only; no model traffic
  -> /api/chat        confirmed send (src/routes/api/chat.ts)
  -> ficta proxy      redact -> forward -> restore   (FICTA_PROXY_URL)
  -> OpenAI / Anthropic
```

Provider API keys stay server-side. The Ficta proxy passes required auth headers through to the provider,
but tokenizes protected values in the model payload before the provider hop and restores them locally
in the streamed response.

The two protection layers have different strengths:

- **Registered values:** exact-match values loaded by the proxy, such as known secrets, client names,
  matter IDs, patient IDs, or other firm-specific identifiers. These get the strongest promise:
  tokenize on egress and block if a registered value survives redaction in a covered surface.
- **Detected values:** best-effort secret-shape and PII detection. This reduces exposure, but it is
  not complete. Undetected PII still goes to the model provider.

Current app capabilities:

- server-side BYO OpenAI/Anthropic keys, including workspace admin-managed provider keys;
- chat history and settings backed by embedded PGlite by default, or Postgres via `DATABASE_URL`;
- model allow-list, default model, and instance-name settings;
- admin-managed Protected Registry for known sensitive values, with CSV paste/import and managed-registry JSON
  export for proxy loading;
- pre-send protection review showing registry matches and detected PII, with user-selected phrases remembered
  for the current chat and optional suggestions routed to the admin Protected Registry queue;
- protection badge/banner polling the proxy's safe `/__ficta/status` endpoint;
- text-file attachments inlined into chat requests so ficta can redact them;
- PDF/DOCX conversion through a document-converter sidecar before inlining/redaction;
- optional WorkOS AuthKit organizations/workspaces (`AUTH_PROVIDER=workos`);
- open local self-hosting mode (`AUTH_PROVIDER=none`) for development and isolated POCs.

## Local POC Setup

This path is for local evaluation, UI development, and fake-data demos. It is **not production as-is**:
by default it uses open local auth, local `.env` files, embedded PGlite, and source-checkout sidecar
management.

```sh
pnpm install
cp apps/gateway/.env.example apps/gateway/.env
```

Edit `apps/gateway/.env` and set at least one fallback model provider key:

```sh
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
```

Gateway admins can also save workspace-scoped OpenAI/Anthropic keys in Admin settings. Saved workspace
keys take precedence over these env keys for that workspace. Set `FICTA_GATEWAY_KEY_ENCRYPTION_SECRET`
before saving admin-managed keys:

```sh
FICTA_GATEWAY_KEY_ENCRYPTION_SECRET="$(openssl rand -base64 32)"
```

For a realistic sensitive-data demo, enable the proxy-side detectors too:

```sh
FICTA_SECRET_SHAPES_ENABLED=1
FICTA_PII_ENABLED=1
FICTA_PII_BACKEND=presidio
FICTA_PII_FAIL_CLOSED=1
FICTA_PII_PRESIDIO_URL=http://127.0.0.1:5002
```

Then start the source-checkout dev stack:

```sh
pnpm dev
```

Open http://localhost:4747.

`pnpm dev` auto-runs through Doppler when the Doppler CLI is installed; otherwise it loads local
`.env` files and starts the proxy plus the web app. It starts or reuses the local Docker
document-converter sidecar by default so PDF/DOCX uploads work in dev; set
`FICTA_DOC_CONVERTER_MANAGED=0` to opt out. When the effective env selects
`FICTA_PII_BACKEND=presidio`, the dev wrapper can also start or reuse a local Docker
`presidio-analyzer` sidecar and mount
`../../packages/ficta/presidio/default_recognizers.za.yaml` plus
`../../packages/ficta/presidio/nlp_engine.za.yaml`.

## Production-Like Gateway Setup

For a law-firm, medical, finance, or other regulated-team POC using real sensitive data, treat this
as an operator-owned internal system, not a hosted SaaS default.

Minimum production-like posture:

- Run the gateway and ficta proxy inside the firm's network boundary.
- Use `AUTH_PROVIDER=workos` or put the app behind an equivalent enterprise auth boundary. Do not
  expose `AUTH_PROVIDER=none` beyond a local or isolated demo network.
- Use `DATABASE_URL` with managed Postgres. Embedded PGlite is for local/single-process use; chat
  history stores the restored user-visible transcript and must be treated as sensitive data.
- Protect `FICTA_GATEWAY_KEY_ENCRYPTION_SECRET` separately from the database. Postgres/PGlite backups
  can contain encrypted workspace provider keys, and this secret is required to decrypt them.
- Define retention, deletion, backup, and access-review policy for chat history.
- Run Presidio as an explicit sidecar under your process/container supervisor. Do not rely on
  source-checkout managed sidecar behavior in production.
- Set `FICTA_PII_FAIL_CLOSED=1` so a detector outage blocks requests instead of silently forwarding
  unscreened text.
- Load a firm-specific exact-match registry for client names, matter IDs, patient IDs, account numbers,
  project names, or other high-value identifiers. Lead demos with this strong layer, not only best-effort
  NER.
- Keep `FICTA_LOG_LEVEL` below `trace`; trace writes raw request/response bodies to disk.
- Decide which provider/deployment is approved for the data class. For medical workflows, redaction
  does not remove the need for the right HIPAA/BAA posture if ePHI can reach a vendor.
- Consider egress allow-listing so the gateway host can reach only the approved model provider,
  Presidio sidecar, document-converter sidecar, database, and auth provider.

Gateway admins can edit a narrow set of proxy safety settings from the Admin settings dialog:
registered-secret fail-closed behavior, PII/secret-shape detection, PII backend and outage policy,
surrogate style, tool-call restore policy, and custom-upstream allowance. These edits are written to
the proxy's `config.toml`; restart the proxy before treating the saved settings as active. Fields set
by explicit `FICTA_*` environment variables remain read-only in the UI.

Gateway admins can also maintain the Protected Registry from **Admin > Protected Registry**. Approved
registry entries can be published to a private managed-registry JSON file and loaded by the running
proxy without a restart. Gateway writes the file atomically and confirms that the proxy parsed that
exact revision; a path, shared-volume, or source error is reported as partial success rather than active
protection. Configure the same absolute path with `FICTA_GATEWAY_MANAGED_REGISTRY_PATH` in Gateway and
`FICTA_REGISTRY_MANAGED_FILE_PATHS` in the proxy. Suggested and ignored rows are review workflow only.

Each chat starts with **Review before send** on, so **Send** opens an inline protection review before any
provider request starts. Users can turn it off for the current chat and turn it back on whenever they want
another review. An admin can lock review on under **Admin > General**. Users can inspect
the original message, switch to the exact surrogate-bearing text the model will see, and select or type a
missed phrase to protect throughout that chat. Chat selections remain user/thread-scoped and do not silently
change workspace policy. **Suggest for workspace** adds review-only rows to the existing Protected Registry;
an admin may edit, approve, and publish them. Stored chat selections are treated as sensitive
application data alongside the restored transcript and are deleted with the thread.

Each confirmation is a short-lived, single-use capability bound to the authenticated user, workspace, chat,
and exact current message. The proxy rejects edited content, replayed confirmations, and confirmations from a
different chat. Several independently reviewed tabs may remain valid at once. Admin-required review is also
enforced by the server API, not only by the browser controls.

One Gateway + proxy deployment serves one organization: the proxy's permanent registry is
process-global. With `AUTH_PROVIDER=workos`, set `FICTA_GATEWAY_ORG_ID` to the deployment's WorkOS
organization ID. Run separate deployments for separate organizations.

Example production-like env shape:

```sh
AUTH_PROVIDER=workos
FICTA_GATEWAY_ORG_ID=org_...
WORKOS_CLIENT_ID=...
WORKOS_API_KEY=...
WORKOS_REDIRECT_URI=https://gateway.example.com/api/auth/callback
WORKOS_COOKIE_PASSWORD=...

DATABASE_URL=postgres://...
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
FICTA_GATEWAY_KEY_ENCRYPTION_SECRET=...

FICTA_PROXY_URL=http://127.0.0.1:8787
FICTA_SECRET_SHAPES_ENABLED=1
FICTA_PII_ENABLED=1
FICTA_PII_BACKEND=presidio
FICTA_PII_FAIL_CLOSED=1
FICTA_PII_PRESIDIO_URL=http://127.0.0.1:5002
FICTA_LOG_LEVEL=info
```

Run the Presidio sidecar explicitly, for example:

```sh
docker run --rm -p 5002:3000 \
  -v "$PWD/packages/ficta/presidio/default_recognizers.za.yaml:/app/ficta-presidio-recognizers.yaml:ro" \
  -v "$PWD/packages/ficta/presidio/nlp_engine.za.yaml:/app/ficta-nlp-engine.yaml:ro" \
  -e RECOGNIZER_REGISTRY_CONF_FILE=/app/ficta-presidio-recognizers.yaml \
  -e NLP_CONF_FILE=/app/ficta-nlp-engine.yaml \
  ghcr.io/data-privacy-stack/presidio-analyzer:latest
```

The shipped recognizer registry keeps Presidio's defaults, enables South African ID numbers, and adds
South African company registration, legal-document identifier, Mauritius phone, and ordinal-date
recognizers. The separate NLP configuration enables noisy, best-effort organization NER; known client
and counterparty names still belong in the exact-match registry.

## Document Conversion

Plain text attachments are read in the browser and inlined into the chat request. PDF/DOCX uploads go
through the document-converter sidecar (`FICTA_DOC_CONVERTER_URL`) via `POST /api/extract`, then the
extracted Markdown is inlined and redacted through the same path. A prompt is optional: an attachment-only
draft uses a generic review instruction and follows the chat's **Review before send** setting.

In a source checkout, root `pnpm dev` starts/reuses the default converter on `http://127.0.0.1:5003`.
Outside that wrapper, use `pnpm sidecars` or run `apps/gateway/sidecars/document-converter` yourself.

Extraction fidelity matters. If the converter drops scanned text, OCR, or table structure, the PII
detector may never see the value. For real document workflows, run the converter inside the same
network boundary and validate it on representative documents before using real sensitive files.

## Environment Reference

Web app env:

| Env var | Purpose | Default |
| --- | --- | --- |
| `FICTA_PROXY_URL` | ficta proxy base URL the model adapters point at | `http://127.0.0.1:8787` |
| `OPENAI_API_KEY` | OpenAI-compatible fallback key; used only when the workspace has no saved OpenAI key | - |
| `ANTHROPIC_API_KEY` | Anthropic fallback key; used only when the workspace has no saved Anthropic key | - |
| `FICTA_GATEWAY_KEY_ENCRYPTION_SECRET` | Secret used to encrypt/decrypt admin-saved workspace provider keys | - |
| `AUTH_PROVIDER` | `none` for open local/self-hosted mode, or `workos` for AuthKit | `none` |
| `FICTA_GATEWAY_ORG_ID` | WorkOS organization assigned to this single-organization Gateway/proxy deployment; required with `AUTH_PROVIDER=workos` | - |
| `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_REDIRECT_URI`, `WORKOS_COOKIE_PASSWORD` | WorkOS AuthKit + organization/workspace support | - |
| `DATABASE_URL` | Postgres connection for shared/multi-process deployments | embedded PGlite when unset |
| `FICTA_GATEWAY_DATA_DIR` | PGlite data directory when `DATABASE_URL` is unset | `.data/pglite` |
| `FICTA_GATEWAY_MANAGED_REGISTRY_PATH` | Private managed-registry file shared with the proxy; use the same absolute path as `FICTA_REGISTRY_MANAGED_FILE_PATHS` | `.data/protected-registry.json` |
| `FICTA_DOC_CONVERTER_URL` | Document-converter sidecar URL for PDF/DOCX extraction | `http://127.0.0.1:5003` |
| `FICTA_DOC_CONVERTER_MANAGED` | Source-checkout `pnpm dev` lifecycle toggle for the converter sidecar | `1` |
| `FICTA_DOC_CONVERTER_BACKEND` | Converter backend label/env passed to the managed sidecar: `markitdown` or `docling` | `markitdown` |

Proxy-side env commonly used with the gateway:

| Env var | Purpose | Default |
| --- | --- | --- |
| `FICTA_SECRET_SHAPES_ENABLED` | Enable best-effort detection of pasted API keys, JWTs, private keys, credential URLs, and secret-ish assignments | unconfigured proxy: `0`; `ficta setup`: prompted/default yes |
| `FICTA_PII_ENABLED` | Enable best-effort PII detection for gateway traffic | unconfigured proxy: `0`; `ficta setup`: prompted/default yes |
| `FICTA_PII_BACKEND` | Legacy single PII backend selector: `regex` or `presidio` | `regex` |
| `FICTA_PII_BACKENDS` | Select one or more PII backends, e.g. `presidio,openmed` | unset → `FICTA_PII_BACKEND` |
| `FICTA_PII_FAIL_CLOSED` | PII detector outage policy: block instead of skip detection | `0` |
| `FICTA_PII_PRESIDIO_URL` | Presidio analyzer URL when using the `presidio` backend | local sidecar URL |
| `FICTA_PII_OPENMED_URL` | OpenMed service URL when using the `openmed` backend | local service URL |
| `FICTA_RESTORE_INTO_TOOLS` | Tool-call restore policy: `detected` restores locally-read detector values while withholding registry secrets; `all` or `none` force either extreme | `detected` |
| `FICTA_ALLOW_CUSTOM_UPSTREAM` | Permit forwarding provider auth headers to trusted non-default upstreams | `0` |
| `FICTA_LOG_LEVEL` | Runtime logging level; `trace` writes raw bodies | `info` standalone |

## Verification

Before any sensitive workflow:

1. Run local checks with fake values only.
2. Confirm the protection badge shows the proxy connected, registered values loaded, and PII detection
   in the intended fail-open/fail-closed posture.
3. Send fake registered identifiers and fake PII through a live provider key and verify the model does
   not receive the registered literals.
4. Stop the Presidio sidecar and confirm `FICTA_PII_FAIL_CLOSED=1` blocks sends rather than forwarding.

Useful commands:

```sh
pnpm gateway:typecheck
pnpm gateway:build
```

Live vendor checks are manual by design because they send test content to a real provider. Use fake
PII and fake secret-shaped values.

## Implementation Seam

`src/lib/model-adapter.ts` is the single place provider/model/key/base-URL are wired. Swapping
providers or pointing at a different gateway is a change there, not throughout the UI.
