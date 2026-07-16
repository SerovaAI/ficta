import { createHash, randomUUID } from "node:crypto";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { type HttpBindings, serve } from "@hono/node-server";
import {
  type EgressProof,
  FICTA_CONFIG_PATH,
  FICTA_DETECTION_PROFILE_HEADER,
  FICTA_EGRESS_EVENT_HEADER,
  FICTA_EGRESS_PROOF_PATH,
  FICTA_HEALTH_PATH,
  FICTA_PROTECTION_PREVIEW_PATH,
  FICTA_PROTECTION_STATS_PATH,
  FICTA_PROTECTION_TICKET_HEADER,
  FICTA_REGISTRY_RELOAD_PATH,
  FICTA_REGISTRY_REVISION_HEADER,
  FICTA_RESTORE_HIGHLIGHT_END,
  FICTA_RESTORE_HIGHLIGHT_HEADER,
  FICTA_RESTORE_HIGHLIGHT_METADATA,
  FICTA_RESTORE_HIGHLIGHT_ORIGIN,
  FICTA_RESTORE_HIGHLIGHT_START,
  FICTA_SCOPE_HEADER,
  FICTA_STATUS_PATH,
  FICTA_TRACE_CAPTURE_HEADER,
  FICTA_TRACE_CAPTURE_PATH,
  type ProtectionPreviewFinding,
  type ProtectionPreviewOk,
  type ProtectionPreviewRequest,
  type ProtectionStatsOk,
  type ProtectionStatusOk,
  type ProxyConfigOk,
  type ProxyConfigPatchError,
  type RegistryProtectionStatus,
  type RegistryReloadError,
  type RegistryReloadOk,
  type RuntimeTraceCaptureError,
  type RuntimeTraceCaptureOk,
} from "@serovaai/ficta-protocol";
import { type Context, Hono } from "hono";
import { loadConfig, resolveTarget, upstreamPolicyIssue } from "./config.js";
import { configPosture } from "./config-posture.js";
import { detectorFailClosed } from "./engine/detection-policy.js";
import { setEngineWarnSink } from "./engine/diagnostics.js";
import { ProtectionEngine } from "./engine/engine.js";
import { detectionProfileFromCodes } from "./engine/plugins/pii/jurisdictions.js";
import type { DetectionProfile, ProtectedValue } from "./engine/plugins/types.js";
import { withPreservationInstruction } from "./engine/preserve-literals.js";
import {
  type AmbiguousEntityLinkDiagnostic,
  DetectorUnavailableError,
  type ProtectionHit,
  type ProtectionTraceOccurrence,
  type ProtectionTraceValue,
  type RedactionEngine,
  RedactionInvariantError,
  type RequestScope,
  type RestoreTraceDetails,
} from "./engine/redaction-engine.js";
import { surrogateKeyWarning } from "./engine/vault.js";
import { type Wire, wireOf } from "./engine/wire.js";
import {
  currentRunDir,
  logDir,
  logRequest,
  logResponse,
  protectionStatsPath,
  restoredBodyTap,
  writeCaptureFile,
  writeRestoredBody,
  writeTraceAudit,
} from "./log.js";
import { log } from "./logger.js";
import {
  activeBackends,
  backendHealthCheck,
  defaultRedactionPlugins,
  managedRegistryLoadCounts,
  type PluginDiscovery,
  piiEnabled,
  piiFailClosed,
  type RedactionPlugin,
  type RegistryPolicy,
  registryDiscoveryLines,
  registryPolicyLines,
  resetManagedRegistryFilePluginCache,
  retainManagedRegistryFilePluginCacheForCurrentFiles,
  secretShapesEnabled,
  selectedBackendNames,
} from "./plugins/index.js";
import { ProtectionStats, type ProtectionStatsSnapshot, type ProtectionSurface } from "./protection-stats.js";
import {
  applyProxyConfigPatch,
  isLoopbackAddress,
  proxyConfigEditState,
  proxyConfigLockedFields,
} from "./proxy-config-edit.js";
import { decodeRequestBody, MAX_ENCODED_BYTES, RequestBodyDecodeError } from "./request-encoding.js";

export interface ProxyHandle {
  port: number;
  protectedValues: number;
  registry: PluginDiscovery[];
  policyExcluded: number;
  policyExcludedBySource: Record<string, number>;
  registryPolicy: RegistryPolicy;
  keptCount: () => number;
  protectionStats: () => ProtectionStatsSnapshot;
  statsSummary: () => string;
  close: () => void;
}

/** Start the redaction proxy. Returns the bound port + a handle to close it. */
export async function startProxy(
  opts: { host?: string; port?: number; plugins?: readonly RedactionPlugin[] } = {},
): Promise<ProxyHandle> {
  // Reconnect the engine's detector-domain warnings (e.g. a PII backend being unavailable) to the
  // proxy's pino logger. The engine itself carries no logger dependency (see diagnostics.ts); this is
  // the single wiring point, and it covers both the standalone proxy and the agent-launch path
  // (cli.ts → startProxy). A bare-library engine with no sink wired stays silent by design.
  setEngineWarnSink((fields, message) => log.warn(fields, message));
  const cfg = loadConfig();
  const configEditLocks = proxyConfigLockedFields();
  const engine: RedactionEngine = new ProtectionEngine({ plugins: opts.plugins ?? defaultRedactionPlugins });
  const stats = new ProtectionStats(protectionStatsPath, { captureDir: currentRunDir });
  const protectionTickets = new Map<string, ProtectionTicket>();
  const egressProofs = new Map<string, EgressProof>();
  let runtimeTraceCaptureEnabled = false;
  const app = new Hono<{ Bindings: HttpBindings }>();

  app.all("*", async (c) => {
    const url = new URL(c.req.url);
    const method = c.req.method;
    // Belt-and-braces with the socket-level "upgrade" listener below: refuse WebSocket upgrade
    // attempts locally instead of forwarding a doomed (but authenticated) GET upstream. Clients
    // with an HTTP fallback (e.g. Pi's Codex transport) retry over SSE immediately.
    if (c.req.raw.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return refusedWebSocketUpgradeResponse(c, url.pathname);
    }
    if (url.pathname === FICTA_HEALTH_PATH) return c.json({ ok: true, service: "ficta" });
    if (url.pathname === FICTA_STATUS_PATH) return c.json(await protectionStatus(engine, stats));
    if (url.pathname === FICTA_PROTECTION_STATS_PATH) return c.json(protectionStatsResponse(stats, url));
    if (url.pathname === FICTA_EGRESS_PROOF_PATH) {
      if (method !== "GET")
        return c.json({ error: { type: "method_not_allowed", message: "Use GET for egress proof." } }, 405);
      if (!isLoopbackAddress(c.env.incoming.socket.remoteAddress)) {
        return c.json({ error: { type: "forbidden", message: "Egress proof is loopback-only." } }, 403);
      }
      const scopeKey = scopeKeyFrom(c);
      const eventId = egressEventIdFrom(c);
      if (!scopeKey || !eventId) {
        return c.json(
          { error: { type: "invalid_request", message: "A trusted scope and egress event id are required." } },
          400,
        );
      }
      const proof = egressProofs.get(egressProofKey(scopeKey, eventId));
      if (!proof) return c.json({ error: { type: "not_found", message: "Egress proof is not available yet." } }, 404);
      return c.json({ ok: true, service: "ficta", proof });
    }
    if (url.pathname === FICTA_TRACE_CAPTURE_PATH) {
      if (!isLoopbackAddress(c.env.incoming.socket.remoteAddress)) {
        return c.json(
          {
            ok: false,
            service: "ficta",
            status: "forbidden",
            message: "Runtime trace capture can be administered only from loopback clients.",
          } satisfies RuntimeTraceCaptureError,
          403,
        );
      }
      if (method === "GET") {
        return c.json({
          ok: true,
          service: "ficta",
          traceCapture: { enabled: runtimeTraceCaptureEnabled },
        } satisfies RuntimeTraceCaptureOk);
      }
      if (method === "PATCH") {
        let patch: unknown;
        try {
          patch = await c.req.json();
        } catch {
          patch = undefined;
        }
        if (!isRuntimeTraceCapturePatch(patch)) {
          return c.json(
            {
              ok: false,
              service: "ficta",
              status: "invalid_patch",
              message: "Trace capture patch must contain only an enabled boolean.",
            } satisfies RuntimeTraceCaptureError,
            400,
          );
        }
        runtimeTraceCaptureEnabled = patch.enabled;
        const traceCapture = { enabled: runtimeTraceCaptureEnabled };
        log.warn(
          { traceCaptureEnabled: traceCapture.enabled },
          traceCapture.enabled
            ? "Sensitive runtime trace capture enabled by a server administrator"
            : "Sensitive runtime trace capture disabled by a server administrator",
        );
        return c.json({ ok: true, service: "ficta", traceCapture } satisfies RuntimeTraceCaptureOk);
      }
      return c.json({ error: { type: "method_not_allowed", message: "Use GET or PATCH for trace capture." } }, 405);
    }
    if (url.pathname === FICTA_PROTECTION_PREVIEW_PATH) {
      if (method !== "POST") {
        return c.json({ error: { type: "method_not_allowed", message: "Use POST for protection preview." } }, 405);
      }
      if (!isLoopbackAddress(c.env.incoming.socket.remoteAddress)) {
        return c.json(
          { ok: false, service: "ficta", status: "forbidden", message: "Protection preview is loopback-only." },
          403,
        );
      }
      const scopeKey = scopeKeyFrom(c);
      if (!scopeKey) {
        return c.json(
          { ok: false, service: "ficta", status: "invalid_request", message: "A trusted scope is required." },
          400,
        );
      }
      let preview: ProtectionPreviewRequest;
      try {
        preview = validateProtectionPreviewRequest(await c.req.json());
      } catch (err) {
        return c.json(
          {
            ok: false,
            service: "ficta",
            status: "invalid_request",
            message: err instanceof Error ? err.message : "Invalid protection preview request.",
          },
          400,
        );
      }

      const scope = engine.beginRequest(scopeKey, { detectionProfile: detectionProfileFrom(c) });
      const selected = preview.protectedValues ?? [];
      scope.registerProtectedValues(selected.map(userProtectedValue));
      try {
        const result = await scope.redactBodyDetailed(JSON.stringify(preview.text), {
          path: FICTA_PROTECTION_PREVIEW_PATH,
          traceOccurrences: true,
        });
        if (result.leaks > 0) throw new RedactionInvariantError("preview left known values unprotected");
        const redactedText = JSON.parse(result.body) as unknown;
        if (typeof redactedText !== "string") throw new RedactionInvariantError("preview body shape changed");
        const ticket = randomUUID();
        const now = Date.now();
        pruneProtectionTickets(protectionTickets, now);
        pruneScopeProtectionTickets(protectionTickets, scopeKey);
        const textSha256 = sha256(preview.text);
        protectionTickets.set(ticket, {
          scopeKey,
          protectedValues: selected,
          textSha256,
          expiresAt: now + PROTECTION_TICKET_TTL_MS,
        });
        const response: ProtectionPreviewOk = {
          ok: true,
          service: "ficta",
          ticket,
          textSha256,
          redactedText,
          findings: protectionPreviewFindings(result.traceOccurrences ?? []),
        };
        return c.json(response);
      } catch (err) {
        if (err instanceof DetectorUnavailableError) {
          return c.json(
            {
              ok: false,
              service: "ficta",
              status: "detector_unavailable",
              message: `Protection preview could not run because ${err.plugin} is unavailable.`,
            },
            503,
          );
        }
        if (err instanceof RedactionInvariantError) {
          return c.json(
            { ok: false, service: "ficta", status: "invariant", message: "Protection preview was blocked." },
            422,
          );
        }
        throw err;
      }
    }
    // Values-free config posture (see ConfigPosture). Kept separate from FICTA_STATUS_PATH, which the
    // gateway's non-admin protection widget polls: transport config (upstreams, host/port, log dir)
    // is admin-facing, and the gateway gates its fetch server-side. The proxy itself stays
    // auth-free and loopback-bound; this endpoint adds no secrets to expose.
    if (url.pathname === FICTA_CONFIG_PATH) {
      if (method === "GET") {
        const response: ProxyConfigOk = {
          ok: true,
          service: "ficta",
          config: configPosture(cfg, process.env, { traceCapture: { enabled: runtimeTraceCaptureEnabled } }),
          edit: proxyConfigEditState(cfg, configEditLocks),
        };
        return c.json(response);
      }
      if (method === "PATCH") {
        const remoteAddress = c.env.incoming.socket.remoteAddress;
        if (!isLoopbackAddress(remoteAddress)) {
          return c.json(
            {
              ok: false,
              service: "ficta",
              status: "forbidden",
              message: "Proxy config edits are accepted only from loopback clients.",
            } satisfies ProxyConfigPatchError,
            403,
          );
        }
        let patch: unknown;
        try {
          patch = await c.req.json();
        } catch {
          return c.json(
            {
              ok: false,
              service: "ficta",
              status: "invalid_patch",
              message: "Config patch must be valid JSON.",
            } satisfies ProxyConfigPatchError,
            400,
          );
        }
        const result = applyProxyConfigPatch(cfg, patch, configEditLocks);
        return c.json(result, result.ok ? 200 : result.status === "locked" ? 409 : 400);
      }
      return c.json({ error: { type: "method_not_allowed", message: "Use GET or PATCH for proxy config." } }, 405);
    }
    // Live registry reload: re-read the env-configured managed registry file(s) and register any NEW
    // values into the running engine (the gateway's "Publish to proxy" action). The request body is
    // never read — no paths or values are accepted from the caller; reload can only re-load what the
    // operator already configured via FICTA_REGISTRY_MANAGED_FILE_PATHS. Deletions apply on restart
    // (see ProtectionEngine.reloadRegistryValues). Response carries counts only, never values.
    if (url.pathname === FICTA_REGISTRY_RELOAD_PATH) {
      if (method !== "POST") {
        return c.json({ error: { type: "method_not_allowed", message: "Use POST for registry reload." } }, 405);
      }
      const remoteAddress = c.env.incoming.socket.remoteAddress;
      if (!isLoopbackAddress(remoteAddress)) {
        return c.json(
          {
            ok: false,
            service: "ficta",
            status: "forbidden",
            message: "Registry reload is accepted only from loopback clients.",
          } satisfies RegistryReloadError,
          403,
        );
      }
      if (!engine.reloadRegistryValues) {
        return c.json(
          {
            ok: false,
            service: "ficta",
            status: "unsupported",
            message: "This engine has no reloadable registry.",
          } satisfies RegistryReloadError,
          501,
        );
      }
      // Explicit cache bust before reloading: the stat-based cache key catches ordinary file edits, but
      // a rewrite landing with an identical {mtimeMs, size} fingerprint would otherwise be missed.
      resetManagedRegistryFilePluginCache();
      let reloaded: ReturnType<NonNullable<typeof engine.reloadRegistryValues>>;
      try {
        reloaded = engine.reloadRegistryValues();
      } catch (error) {
        retainManagedRegistryFilePluginCacheForCurrentFiles();
        log.warn({ error }, "registry reload rejected invalid source data; retaining the active registry");
        return c.json(
          {
            ok: false,
            service: "ficta",
            status: "invalid_registry",
            message: error instanceof Error ? error.message : "Managed registry validation failed.",
          } satisfies RegistryReloadError,
          409,
        );
      }
      // Counts-only source health and revision acknowledgement; managed registry responses do not expose values.
      const expectedRevision = c.req.header(FICTA_REGISTRY_REVISION_HEADER)?.trim();
      const { revisions, ...managed } = managedRegistryLoadCounts();
      const revision = expectedRevision && revisions.includes(expectedRevision) ? expectedRevision : undefined;
      log.info(
        {
          added: reloaded.added,
          total: reloaded.total,
          restartRequired: reloaded.restartRequired,
          ...managed,
          revisionConfirmed: revision !== undefined,
        },
        `🔄 registry reload: +${reloaded.added} value(s), ${reloaded.total} total`,
      );
      const response: RegistryReloadOk = {
        ok: true,
        service: "ficta",
        registry: { ...reloaded, ...managed, ...(revision ? { revision } : {}) },
      };
      return c.json(response);
    }

    // Strict registry mode is a runtime egress invariant, not only an agent-launch preflight. Keep
    // control-plane endpoints above reachable so an operator can inspect status and publish/fix the
    // managed registry without restarting the proxy; only provider-bound traffic is paused.
    const registry = registryProtectionStatus(engine);
    if (registry.required && registry.status !== "ready") {
      log.warn(
        { method, path: url.pathname, registryStatus: registry.status },
        "Provider request blocked because the required protected registry is not ready",
      );
      return c.json(
        {
          error: {
            type: "ficta_registry_unavailable",
            message: registry.message,
          },
        },
        503,
      );
    }

    // Protect every outbound request body, query string, and non-auth header by default.
    // Provider/client paths change, and an "unknown" route can still carry conversation/tool
    // content; exact-match redaction is safe.
    const requestedProtectionTicket = c.req.header(FICTA_PROTECTION_TICKET_HEADER)?.trim();
    const protect = engine.protecting || Boolean(requestedProtectionTicket);
    const wire = wireOf(url.pathname);
    const traceCapture = traceCaptureDecisionFrom(c, runtimeTraceCaptureEnabled, cfg.traceAudit);
    const captureRawBodies = traceCapture.bodyLogged;
    const captureTraceAudit = traceCapture.valueAuditLogged;
    const restoreHighlightMarkers =
      c.req.header(FICTA_RESTORE_HIGHLIGHT_HEADER) === "1"
        ? {
            start: FICTA_RESTORE_HIGHLIGHT_START,
            origin: FICTA_RESTORE_HIGHLIGHT_ORIGIN,
            metadata: FICTA_RESTORE_HIGHLIGHT_METADATA,
            end: FICTA_RESTORE_HIGHLIGHT_END,
          }
        : undefined;
    const restoreHighlightOptions = restoreHighlightMarkers ? { markers: restoreHighlightMarkers } : undefined;

    // One scope per request: registered secrets (the permanent layer) are shared, while detected
    // PII is consulted only within the request's scope. Without a scope key the scope is dropped
    // when the handler returns, so detected values are bounded and can never be restored into
    // another request's response. A trusted caller may pin a persistent per-thread detected vault
    // via the internal scope header (see scopeKeyFrom); isolation then holds across keys instead.
    const scopeKey = scopeKeyFrom(c);
    const scope = engine.beginRequest(scopeKey, { detectionProfile: detectionProfileFrom(c) });
    const egressEvidence = createEgressEvidence({
      scopeKey,
      eventId: egressEventIdFrom(c),
      protectedRequest: protect,
      proofs: egressProofs,
    });
    let preparedProtectionTicket: ProtectionTicket | undefined;
    if (requestedProtectionTicket) {
      const prepared = protectionTickets.get(requestedProtectionTicket);
      if (!prepared || prepared.expiresAt <= Date.now() || prepared.scopeKey !== scopeKey) {
        if (prepared?.expiresAt !== undefined && prepared.expiresAt <= Date.now()) {
          protectionTickets.delete(requestedProtectionTicket);
        }
        return c.json(
          {
            error: {
              type: "ficta_protection_preview_stale",
              message: "Protection preview expired or does not belong to this chat. Preview again before sending.",
            },
          },
          409,
        );
      }
      if (method === "GET" || method === "HEAD") {
        return c.json(
          { error: { type: "ficta_protection_preview_stale", message: "Protection tickets require a request body." } },
          409,
        );
      }
      preparedProtectionTicket = prepared;
    }
    const traceRedactions: ProtectionTraceRedaction[] = [];

    let searchToSend = url.search;
    let queryRedaction: SurfaceRedaction | undefined;
    if (protect && searchToSend) {
      let redactedQuery: QueryRedaction;
      try {
        redactedQuery = await redactQueryString(scope, url, captureTraceAudit);
      } catch (err) {
        if (err instanceof DetectorUnavailableError) {
          const n = logRequest({
            method,
            path: url.pathname,
            body: "",
            target: "<blocked>",
            route: "blocked",
            captureRawBodies,
            traceCapture,
          });
          recordDetectorUnavailable(stats, scope, traceRedactions, {
            evidence: egressEvidence,
            requestId: n,
            method,
            path: url.pathname,
            wire,
            route: "blocked",
            surface: "query string",
            captureTraceAudit,
          });
          return blockedDetectionResponse(c, err.plugin, n);
        }
        throw err;
      }
      const { search: redactedSearch, ...redaction } = redactedQuery;
      queryRedaction = redaction;
      if (redaction.leaks > 0 && cfg.failClosed) {
        const n = logRequest({
          method,
          path: url.pathname,
          body: "",
          target: "<blocked>",
          route: "blocked",
          captureRawBodies,
          traceCapture,
        });
        recordProtection(stats, scope, traceRedactions, {
          evidence: egressEvidence,
          requestId: n,
          method,
          path: url.pathname,
          wire,
          surface: "query string",
          redaction,
          blocked: true,
        });
        writeProtectionTraceAudit(n, traceRedactions, scope, "blocked", captureTraceAudit);
        return blockedLeakResponse(c, "query string", redaction.leaks, n, redaction.leakHits);
      }
      if (redaction.count > 0) searchToSend = redactedSearch;
    }

    const { url: target, note: route } = resolveTarget(cfg, url.pathname, searchToSend, c.req.raw.headers);
    const upstreamIssue = upstreamPolicyIssue(cfg, target);
    if (upstreamIssue) {
      const n = logRequest({
        method,
        path: url.pathname,
        body: "",
        target: "<blocked>",
        route,
        captureRawBodies,
        traceCapture,
      });
      if (queryRedaction) {
        recordProtection(stats, scope, traceRedactions, {
          evidence: egressEvidence,
          requestId: n,
          method,
          path: url.pathname,
          wire,
          route,
          surface: "query string",
          redaction: queryRedaction,
          blocked: false,
        });
      }
      writeProtectionTraceAudit(n, traceRedactions, scope, "blocked", captureTraceAudit);
      egressEvidence?.finish("blocked");
      return c.json({ error: { type: "ficta_upstream_policy", message: upstreamIssue } }, 403);
    }

    const headers = new Headers(c.req.raw.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("accept-encoding");
    headers.delete(FICTA_SCOPE_HEADER); // internal routing metadata — must never reach the upstream vendor
    headers.delete(FICTA_DETECTION_PROFILE_HEADER); // internal detection selector — must never reach upstream
    headers.delete(FICTA_EGRESS_EVENT_HEADER); // internal audit metadata — must never reach the upstream vendor
    headers.delete(FICTA_TRACE_CAPTURE_HEADER); // internal trace/audit selector — must never reach upstream
    headers.delete(FICTA_RESTORE_HIGHLIGHT_HEADER); // client display capability — must never reach upstream
    headers.delete(FICTA_PROTECTION_TICKET_HEADER); // opaque preflight capability — must never reach upstream

    let bodyToSend: string | undefined;
    let n: number;
    let requestModel = "unknown";

    if (method !== "GET" && method !== "HEAD") {
      // Decode a compressed request body (e.g. Pi zstd-compresses its Codex-backend POSTs) so
      // redaction screens the real text — the alternative is screening mojibake and forwarding a
      // corrupted body. Undecodable bodies are refused outright: opaque bytes cannot be screened.
      let bodyText: string;
      const raw = await readBoundedRequestBody(c.req.raw);
      if (raw === null) return refusedRequestTooLargeResponse(c, method, url.pathname);
      try {
        const decodedBody = decodeRequestBody(raw, headers.get("content-encoding"));
        // The upstream request carries the decoded body, so the coding header must not survive.
        if (decodedBody.decoded) headers.delete("content-encoding");
        bodyText = new TextDecoder().decode(decodedBody.body);
      } catch (err) {
        if (err instanceof RequestBodyDecodeError) return refusedRequestEncodingResponse(c, err, method, url.pathname);
        throw err;
      }
      if (requestedProtectionTicket && preparedProtectionTicket) {
        const stillCurrent = protectionTickets.get(requestedProtectionTicket);
        if (
          stillCurrent !== preparedProtectionTicket ||
          preparedProtectionTicket.expiresAt <= Date.now() ||
          !requestContainsReviewedText(bodyText, preparedProtectionTicket.textSha256)
        ) {
          if (stillCurrent === preparedProtectionTicket) protectionTickets.delete(requestedProtectionTicket);
          return c.json(
            {
              error: {
                type: "ficta_protection_preview_stale",
                message: "The outbound message no longer matches the protection preview. Preview again before sending.",
              },
            },
            409,
          );
        }
        // Consume atomically before any detector/upstream await. Concurrent replay sees a missing ticket.
        protectionTickets.delete(requestedProtectionTicket);
        scope.registerProtectedValues(preparedProtectionTicket.protectedValues.map(userProtectedValue));
      }
      const originalModel = requestModelFromBody(bodyText);
      n = logRequest({ method, path: url.pathname, body: bodyText, target, route, captureRawBodies, traceCapture });

      if (protect) {
        let redaction: Awaited<ReturnType<typeof scope.redactBodyDetailed>>;
        try {
          redaction = await scope.redactBodyDetailed(bodyText, {
            path: url.pathname,
            traceValues: captureTraceAudit,
          });
        } catch (err) {
          // A fail-closed detector (e.g. Presidio required but unreachable) refuses the request rather
          // than forwarding data it could not screen. The raw body has not left the process.
          if (err instanceof DetectorUnavailableError) {
            recordDetectorUnavailable(stats, scope, traceRedactions, {
              evidence: egressEvidence,
              requestId: n,
              method,
              path: url.pathname,
              wire,
              route,
              model: safeRequestModel(scope, originalModel, undefined),
              surface: "body",
              captureTraceAudit,
            });
            return blockedDetectionResponse(c, err.plugin, n);
          }
          if (err instanceof RedactionInvariantError) return blockedInvariantResponse(c, err.reason, n);
          throw err;
        }
        const redacted = redaction.body;
        requestModel = safeRequestModel(scope, originalModel, requestModelFromBody(redacted));
        if (queryRedaction) {
          recordProtection(stats, scope, traceRedactions, {
            evidence: egressEvidence,
            requestId: n,
            method,
            path: url.pathname,
            wire,
            route,
            model: requestModel,
            surface: "query string",
            redaction: queryRedaction,
            blocked: false,
          });
        }
        if (redaction.leaks > 0 && cfg.failClosed) {
          recordProtection(stats, scope, traceRedactions, {
            evidence: egressEvidence,
            requestId: n,
            method,
            path: url.pathname,
            wire,
            route,
            model: requestModel,
            surface: "body",
            redaction,
            blocked: true,
          });
          writeProtectionTraceAudit(n, traceRedactions, scope, "blocked", captureTraceAudit);
          return blockedLeakResponse(c, "body", redaction.leaks, n, redaction.leakHits);
        }
        if (redaction.count > 0 || redaction.leaks > 0) {
          recordProtection(stats, scope, traceRedactions, {
            evidence: egressEvidence,
            requestId: n,
            method,
            path: url.pathname,
            wire,
            route,
            model: requestModel,
            surface: "body",
            redaction,
            blocked: false,
          });
          if (redaction.count > 0) {
            const warn = redaction.leaks > 0 ? `  ⚠ ${redaction.leaks} LEAKED (fail-open)` : "";
            const ambiguity =
              redaction.ambiguousEntityLinks > 0 ? `; ${redaction.ambiguousEntityLinks} ambiguous entity link(s)` : "";
            const fields = {
              reqId: n,
              kept: redaction.count,
              leaked: redaction.leaks,
              ambiguousEntityLinks: redaction.ambiguousEntityLinks,
              surface: "body",
            };
            const msg = `🔒 kept ${redaction.count} body value(s) out of the model${warn}${ambiguity}`;
            if (redaction.leaks > 0) log.warn(fields, msg);
            else log.info(fields, msg);
          }
        }
        bodyToSend = redacted;
        // Tell the model to preserve the surrogate literals verbatim (opt-in). Runs after the fail-closed
        // leak gate and only adds surrogate tokens the proxy already minted, so it introduces no new leak.
        if (cfg.preserveLiterals) {
          const surrogates = scope.mintedSurrogatesIn(redacted);
          if (surrogates.length > 0) bodyToSend = withPreservationInstruction(redacted, wire, surrogates);
        }
        if (captureRawBodies) writeCaptureFile(`req-${String(n).padStart(4, "0")}.sent.json`, bodyToSend);
      } else {
        bodyToSend = bodyText;
      }
    } else {
      n = logRequest({ method, path: url.pathname, body: "", target, route, captureRawBodies, traceCapture });
      if (queryRedaction) {
        recordProtection(stats, scope, traceRedactions, {
          evidence: egressEvidence,
          requestId: n,
          method,
          path: url.pathname,
          wire,
          route,
          surface: "query string",
          redaction: queryRedaction,
          blocked: false,
        });
      }
    }

    if (protect) {
      let redaction: SurfaceRedaction;
      try {
        redaction = await redactNonAuthHeaders(scope, headers, captureTraceAudit);
      } catch (err) {
        if (err instanceof DetectorUnavailableError) {
          recordDetectorUnavailable(stats, scope, traceRedactions, {
            evidence: egressEvidence,
            requestId: n,
            method,
            path: url.pathname,
            wire,
            route,
            model: requestModel,
            surface: "non-auth headers",
            captureTraceAudit,
          });
          return blockedDetectionResponse(c, err.plugin, n);
        }
        throw err;
      }
      if (redaction.leaks > 0 && cfg.failClosed) {
        recordProtection(stats, scope, traceRedactions, {
          evidence: egressEvidence,
          requestId: n,
          method,
          path: url.pathname,
          wire,
          route,
          model: requestModel,
          surface: "non-auth headers",
          redaction,
          blocked: true,
        });
        writeProtectionTraceAudit(n, traceRedactions, scope, "blocked", captureTraceAudit);
        return blockedLeakResponse(c, "headers", redaction.leaks, n, redaction.leakHits);
      }
      if (redaction.count > 0 || redaction.leaks > 0) {
        recordProtection(stats, scope, traceRedactions, {
          evidence: egressEvidence,
          requestId: n,
          method,
          path: url.pathname,
          wire,
          route,
          model: requestModel,
          surface: "non-auth headers",
          redaction,
          blocked: false,
        });
        if (redaction.count > 0) {
          const warn = redaction.leaks > 0 ? `  ⚠ ${redaction.leaks} LEAKED (fail-open)` : "";
          const fields = { reqId: n, kept: redaction.count, leaked: redaction.leaks, surface: "non-auth headers" };
          const msg = `🔒 kept ${redaction.count} non-auth header value(s) out of the model${warn}`;
          if (redaction.leaks > 0) log.warn(fields, msg);
          else log.info(fields, msg);
        }
      }
    }

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(target, { method, headers, body: bodyToSend });
    } catch (err) {
      log.error({ reqId: n, err: (err as Error).message }, `✗ upstream fetch failed: ${(err as Error).message}`);
      writeProtectionTraceAudit(n, traceRedactions, scope, "upstream-error", captureTraceAudit);
      egressEvidence?.finish("upstream_error", requestModel);
      return c.json({ error: { type: "ficta_upstream_error", message: String(err) } }, 502);
    }
    egressEvidence?.finish("forwarded", requestModel);

    const resHeaders = new Headers(upstreamRes.headers);
    resHeaders.delete("content-encoding");
    resHeaders.delete("content-length");
    // We always re-frame the body (stream restore or buffered JSON restore), so the upstream's
    // framing header must not survive: a buffered restore sets Content-Length, which is illegal
    // alongside a forwarded Transfer-Encoding: chunked.
    resHeaders.delete("transfer-encoding");
    const contentType = resHeaders.get("content-type") ?? "";
    // Some upstreams stream SSE with no content-type header — notably the ChatGPT/Codex backend
    // (`/backend-api/codex/responses`). When the type is missing but the request is a known model
    // wire, the response is that wire's event stream, so restore it instead of passing surrogates
    // through verbatim (which would leak FICTA_ placeholders into the agent's output).
    const treatAsEventStream = isEventStreamContentType(contentType) || (contentType === "" && wire !== "unknown");
    const restoreResponse = protect && (isRestorableContentType(contentType) || treatAsEventStream);

    // Symmetric with the `🔒 … kept N` egress line: report how many distinct values were restored
    // back into this response. Restore is a streaming rewrite, so for streamed bodies this fires from
    // the tap's flush once the stream closes (i.e. after the `← #N` line); for buffered bodies it
    // fires inline the moment restore has run. Zero restores (the common case) stay quiet.
    const logRestore = () => {
      const restored = scope.restoredCount;
      if (restored > 0) {
        log.info({ reqId: n, restored }, `♻️ restored ${restored} value(s) in response`);
      }
      // A registered/detected value the model tried to place into a tool-call argument was held
      // back (a placeholder went to the tool instead of the real secret). Surfacing it turns a
      // silent exfil attempt into an operator-visible signal. See FICTA_RESTORE_INTO_TOOLS.
      const withheld = scope.withheldFromToolsCount;
      if (withheld > 0) {
        log.warn({ reqId: n, withheld }, `🛡️ withheld ${withheld} value(s) from tool-call arguments`);
      }
      // A surrogate-shaped token with no dictionary mapping survived restore — the model mutated,
      // truncated, or invented it, and the client received it as-is. Restore correctly refused to
      // guess (exact-match only); surfacing the count turns silent token debris into an operator
      // signal. Observe-only: response bytes are unchanged.
      const residuals = scope.residualSurrogateCount;
      if (residuals > 0) {
        log.warn({ reqId: n, residuals }, `⚠️ ${residuals} unrestored surrogate token(s) left in response`);
      }
      // Persist the counts so they are visible beyond this log line (protection-stats.json, /__ficta/status).
      stats.recordRestore({
        restoredValues: restored,
        withheldFromToolsValues: withheld,
        residualSurrogateValues: residuals,
      });
      writeProtectionTraceAudit(n, traceRedactions, scope, "completed", captureTraceAudit);
    };

    if (upstreamRes.body) {
      const [toClient, toLog] = upstreamRes.body.tee();
      void logResponse({
        n,
        path: url.pathname,
        status: upstreamRes.status,
        contentType,
        stream: toLog,
        captureRawBodies,
      });
      if (!restoreResponse) {
        writeProtectionTraceAudit(n, traceRedactions, scope, "not-restored", captureTraceAudit);
        return new Response(toClient, { status: upstreamRes.status, headers: resHeaders });
      }
      if (treatAsEventStream) {
        // The per-wire adapter reassembles surrogates split across SSE events; an unrecognized wire
        // uses the NOOP adapter, which still restores whole surrogates in each event JSON-safely
        // (see Vault.restoreSseRecord). Cross-event reassembly needs a known wire schema, so it is
        // intentionally not attempted here.
        return new Response(
          toClient
            .pipeThrough(scope.restoreEventStream(wire, restoreHighlightOptions))
            .pipeThrough(restoredBodyTap(n, logRestore, captureRawBodies)),
          {
            status: upstreamRes.status,
            headers: resHeaders,
          },
        );
      }
      if (isJsonContentType(contentType)) {
        // Buffer + JSON-aware restore so a restored value with JSON-special chars stays escaped.
        // Non-streaming JSON bodies are bounded, so giving up streaming here costs nothing.
        const text = await new Response(toClient).text();
        const restored = restoreBufferedBody(scope, wire, contentType, text, restoreHighlightOptions);
        logRestore();
        writeRestoredBody(n, restored, captureRawBodies);
        return new Response(restored, {
          status: upstreamRes.status,
          headers: resHeaders,
        });
      }
      return new Response(
        toClient.pipeThrough(scope.restoreStream()).pipeThrough(restoredBodyTap(n, logRestore, captureRawBodies)),
        {
          status: upstreamRes.status,
          headers: resHeaders,
        },
      );
    }

    const body = await upstreamRes.text();
    void logResponse({ n, path: url.pathname, status: upstreamRes.status, contentType, body, captureRawBodies });
    const restoredBody = restoreResponse
      ? restoreBufferedBody(scope, wire, contentType, body, restoreHighlightOptions)
      : body;
    if (restoreResponse) {
      logRestore();
      writeRestoredBody(n, restoredBody, captureRawBodies);
    } else {
      writeProtectionTraceAudit(n, traceRedactions, scope, "not-restored", captureTraceAudit);
    }
    return new Response(restoredBody, { status: upstreamRes.status, headers: resHeaders });
  });

  const bindHost = opts.host ?? cfg.host;
  // Clients dial in over loopback even when we bind a wildcard host, so the copy-paste instructions
  // should say 127.0.0.1, not 0.0.0.0/::. Only substitute for wildcard binds; a specific LAN IP is
  // the address a client would actually use.
  const clientHost = bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost;
  return new Promise<ProxyHandle>((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port ?? cfg.port, hostname: bindHost }, (info) => {
      const keyWarning = surrogateKeyWarning();
      const registry = registryProtectionStatus(engine);
      log.info(
        {
          url: `http://${bindHost}:${info.port}`,
          clientBaseUrl: `http://${clientHost}:${info.port}`,
          upstreams: cfg.upstreams,
          vault: engine.size,
          registryRequired: registry.required,
          registryStatus: registry.status,
          failClosed: cfg.failClosed,
          logDir,
          runDir: currentRunDir(),
          rawBodies: false,
          rawValueAuditCapable: cfg.traceAudit,
        },
        registry.required && registry.status !== "ready"
          ? `🛑 ficta listening on http://${bindHost}:${info.port} — provider requests blocked until the protected registry is ready (${registry.status})`
          : engine.protecting
            ? `🔒 ficta listening on http://${bindHost}:${info.port} — ${engine.size} value(s), redacting up / restoring back`
            : `⚠ ficta listening on http://${bindHost}:${info.port} — NONE loaded, passthrough`,
      );
      // Per-source discovery + policy detail is the old --ficta-verbose report; keep it at debug.
      for (const line of registryDiscoveryLines(
        engine.registryStatus.discoveries,
        "",
        engine.registryStatus.policyExcludedBySource,
      )) {
        log.debug({}, line.trim());
      }
      for (const line of registryPolicyLines(engine.registryStatus.registryPolicy, "")) {
        log.debug({}, `registry policy exclusion: ${line.trim()}`);
      }
      if (keyWarning) log.warn({}, `key warning: ${keyWarning}`);
      resolve({
        port: info.port,
        protectedValues: engine.size,
        registry: [...engine.registryStatus.discoveries],
        policyExcluded: engine.registryStatus.policyExcluded,
        policyExcludedBySource: { ...engine.registryStatus.policyExcludedBySource },
        registryPolicy: engine.registryStatus.registryPolicy,
        keptCount: () => stats.snapshot().totals.keptOutOfModelValues,
        protectionStats: () => stats.snapshot(),
        statsSummary: () => stats.renderSummary(),
        close: () => {
          server.close();
          // server.close() stops accepting new connections but leaves idle keep-alive
          // sockets open, which keeps the event loop alive and stalls shutdown. Drop them
          // so the process can exit promptly instead of being force-killed.
          (server as { closeAllConnections?: () => void }).closeAllConnections?.();
        },
      });
    });
    // ficta does not proxy WebSockets (frames would bypass redaction), so refuse the handshake at
    // the socket instead of forwarding a doomed (but authenticated) GET upstream. Registering the
    // listener keeps node from routing upgrades to the request handler; the immediate 426 lets
    // WS-first clients with an HTTP fallback (e.g. Pi's Codex transport) retry over SSE at once.
    server.on("upgrade", (req: { url?: string }, socket: { end: (data: string) => void }) => {
      // An upgrade URL can carry credentials in its query string (e.g. ?api_key=…), so log only
      // the pathname, and omit it entirely when the request-target does not parse.
      let path: string | undefined;
      if (req.url !== undefined) {
        try {
          path = new URL(req.url, "http://ficta.invalid").pathname;
        } catch {
          path = undefined;
        }
      }
      log.info(
        { path },
        "⤴ refused WebSocket upgrade — ficta does not proxy WebSockets; client should retry over HTTP",
      );
      socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
  });
}

/**
 * The scope-key seam: an internal header set by a trusted caller (e.g. the web app's server route,
 * which derives it from its own auth as `org:thread`) selects a persistent per-key detected-PII
 * vault, so a value detected on one turn stays redacted on every later turn of the same thread.
 * The key is the isolation boundary — the engine never restores one key's values into another's
 * responses — so callers must derive it from trusted identity, never from client-controlled input
 * alone. Absent the header, every request keeps its own isolated ephemeral scope. The header is
 * stripped before the request is forwarded upstream.
 */
function scopeKeyFrom(c: Context): string | undefined {
  const key = c.req.header(FICTA_SCOPE_HEADER)?.trim();
  if (!key) return undefined;
  return key.length > MAX_SCOPE_KEY_LENGTH ? key.slice(0, MAX_SCOPE_KEY_LENGTH) : key;
}

const MAX_SCOPE_KEY_LENGTH = 256;
const MAX_DETECTION_PROFILE_CODES = 8;

/**
 * The detection-profile seam: a trusted caller (e.g. the Gateway resolving a thread's matter)
 * widens best-effort PII detection with jurisdiction codes. Additive-only by construction —
 * unknown codes are dropped and bundles only ever union onto the detection baseline — so a spoofed
 * header can at worst over-redact. The header is stripped before the request is forwarded upstream.
 */
function detectionProfileFrom(c: Context): DetectionProfile | undefined {
  const raw = c.req.header(FICTA_DETECTION_PROFILE_HEADER)?.trim();
  if (!raw) return undefined;
  return detectionProfileFromCodes(raw.split(",").slice(0, MAX_DETECTION_PROFILE_CODES));
}

function traceCaptureDecisionFrom(
  c: Context,
  globallyEnabled: boolean,
  valueAuditEnabled: boolean,
): {
  globalEnabled: boolean;
  requestedForChat: boolean;
  bodyLogged: boolean;
  valueAuditLogged: boolean;
} {
  const requestedForChat = c.req.header(FICTA_TRACE_CAPTURE_HEADER)?.trim() === "1";
  const bodyLogged = globallyEnabled && requestedForChat;
  return {
    globalEnabled: globallyEnabled,
    requestedForChat,
    bodyLogged,
    valueAuditLogged: bodyLogged && valueAuditEnabled,
  };
}

function isRuntimeTraceCapturePatch(value: unknown): value is { enabled: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { enabled?: unknown }).enabled === "boolean"
  );
}

/** Safe runtime status for first-party UIs. Contains only counts/config/health metadata — never values. */
async function protectionStatus(engine: RedactionEngine, stats: ProtectionStats): Promise<ProtectionStatusOk> {
  const enabled = piiEnabled();
  const configuredBackends = selectedBackendNames();
  const backendSet = activeBackends();
  const failClosed = detectorFailClosed(piiFailClosed());
  const failureMode = failClosed ? "fail-closed" : "fail-open";

  let pii: {
    enabled: boolean;
    configuredBackend: string;
    configuredBackends?: string[];
    backend: string;
    status: "off" | "ok" | "degraded" | "blocking";
    failureMode: "fail-open" | "fail-closed";
    url?: string;
    detail?: string;
    message: string;
  };

  if (!enabled) {
    pii = {
      enabled,
      configuredBackend: configuredBackends.join(","),
      configuredBackends,
      backend: backendSet.backends.map(({ name }) => name).join(","),
      status: "off",
      failureMode,
      message: "PII detection is off; only registered exact values are protected.",
    };
  } else if (backendSet.unknown.length > 0) {
    pii = {
      enabled,
      configuredBackend: configuredBackends.join(","),
      configuredBackends,
      backend: backendSet.backends.map(({ name }) => name).join(","),
      status: "degraded",
      failureMode,
      message: `Unknown PII backend(s) "${backendSet.unknown.join(", ")}" configured; skipping them.`,
    };
  } else {
    const healthChecks = await Promise.all(
      backendSet.backends.flatMap(({ name }) => {
        const probe = backendHealthCheck(name);
        return probe ? [probe().then((health) => ({ name, ...health }))] : [];
      }),
    );
    const failed = healthChecks.filter((health) => !health.ok);
    if (failed.length === 0) {
      pii = {
        enabled,
        configuredBackend: configuredBackends.join(","),
        configuredBackends,
        backend: backendSet.backends.map(({ name }) => name).join(","),
        status: "ok",
        failureMode,
        ...(healthChecks.length === 1 ? { url: healthChecks[0]?.url } : {}),
        message: `PII detection is active with backend(s): ${backendSet.backends.map(({ name }) => name).join(", ")}.`,
      };
    } else {
      const first = failed[0];
      pii = {
        enabled,
        configuredBackend: configuredBackends.join(","),
        configuredBackends,
        backend: backendSet.backends.map(({ name }) => name).join(","),
        status: failClosed ? "blocking" : "degraded",
        failureMode,
        url: first?.url,
        ...(first?.detail ? { detail: first.detail } : {}),
        message: failClosed
          ? `PII backend "${first?.name}" is unreachable at ${first?.url}; fail-closed is active, so requests will be blocked before reaching the model.`
          : `PII backend "${first?.name}" is unreachable at ${first?.url}; fail-open is active, so that backend is skipped while reachable backends still run.`,
      };
    }
  }

  return {
    ok: true,
    service: "ficta",
    registry: registryProtectionStatus(engine),
    protection: {
      enabled: engine.enabled,
      protecting: engine.protecting,
      registeredValues: engine.size,
      policyExcluded: engine.registryStatus.policyExcluded,
    },
    secretShapes: {
      enabled: secretShapesEnabled(),
      status: secretShapesEnabled() ? "ok" : "off",
      message: secretShapesEnabled()
        ? "Secret-shape detection is active for known API keys, JWTs, private keys, credential URLs, and secret-ish assignments."
        : "Secret-shape detection is off; only registered exact secrets and enabled PII detection are protected.",
    },
    pii,
    // Cumulative counts for this proxy run. `withheldFromTools` > 0 means the model placed a
    // protected value inside a tool-call argument and a placeholder went to the sink instead —
    // an operator-worthy signal that was previously visible only as a log line.
    activity: {
      restoredValues: stats.restoredValues,
      withheldFromTools: stats.withheldFromToolsValues,
    },
  };
}

/** One source of truth for request gating, startup posture, and the Gateway status response. */
function registryProtectionStatus(engine: RedactionEngine): RegistryProtectionStatus {
  const required = process.env.FICTA_REQUIRE_REGISTRY === "1" && process.env.FICTA_ALLOW_EMPTY !== "1";
  const sourceErrored = engine.registryStatus.discoveries.some((discovery) => discovery.status === "error");
  if (sourceErrored) {
    return {
      required,
      status: "error",
      message: required
        ? "The required protected registry did not load successfully. Fix or republish it before sending."
        : "One or more protected-registry sources failed to load.",
    };
  }
  if (engine.size === 0) {
    return {
      required,
      status: "empty",
      message: required
        ? "This deployment requires registered protected values, but none are loaded. Publish the protected registry before sending."
        : "No registered protected values are loaded.",
    };
  }
  return {
    required,
    status: "ready",
    message: `${engine.size} registered protected value${engine.size === 1 ? " is" : "s are"} loaded.`,
  };
}

const DEFAULT_PROTECTION_STATS_LIMIT = 100;
const MAX_PROTECTION_STATS_LIMIT = 500;
const PROTECTION_PREVIEW_TEXT_MAX = 2 * 1024 * 1024;
const PROTECTION_PREVIEW_VALUES_MAX = 200;
const PROTECTION_PREVIEW_VALUE_MAX = 2_000;
const PROTECTION_PREVIEW_VALUES_BYTES_MAX = 64 * 1024;
const PROTECTION_TICKET_TTL_MS = 5 * 60_000;
const PROTECTION_TICKETS_MAX = 256;
const PROTECTION_TICKETS_PER_SCOPE_MAX = 8;
const REQUIRED_AUTH_HEADER_NAMES = new Set(["authorization", "proxy-authorization", "x-api-key", "cookie"]);
const SURROGATE_RE = /FICTA_(?:[0-9a-f]{32}|[A-Z0-9]{1,12}_[0-9a-f]{32}|(?:ORG|PERSON)_[A-Z2-7]{12}_[A-Z2-7]{12})/;

interface SurfaceRedaction {
  count: number;
  leaks: number;
  ambiguousEntityLinks: number;
  hits: ProtectionHit[];
  leakHits: ProtectionHit[];
  traceValues?: ProtectionTraceValue[];
  traceLeakValues?: ProtectionTraceValue[];
  traceAmbiguousEntityLinks?: AmbiguousEntityLinkDiagnostic[];
}

interface ProtectionTraceRedaction {
  surface: ProtectionSurface;
  blocked: boolean;
  redactedCount: number;
  survivingCount: number;
  ambiguousEntityLinks: number;
  redactedValues: ProtectionTraceValue[];
  survivingValues: ProtectionTraceValue[];
  ambiguousLinks: AmbiguousEntityLinkDiagnostic[];
}

interface ProtectionTraceAudit {
  version: 1;
  requestId: number;
  outcome: "blocked" | "completed" | "not-restored" | "upstream-error";
  redactions: ProtectionTraceRedaction[];
  restore: RestoreTraceDetails;
}

interface ProtectionTicket {
  scopeKey: string;
  protectedValues: string[];
  textSha256: string;
  expiresAt: number;
}

/**
 * A values-free, one-request proof held briefly by the proxy so Gateway can durably append it to the
 * thread ledger after the streamed run finishes. This is intentionally not a transcript log.
 */
interface EgressEvidence {
  record(redaction: SurfaceRedaction): void;
  detectorUnavailable(): void;
  finish(outcome: EgressProof["outcome"], model?: string): void;
}

function createEgressEvidence({
  scopeKey,
  eventId,
  protectedRequest,
  proofs,
}: {
  scopeKey: string | undefined;
  eventId: string | undefined;
  protectedRequest: boolean;
  proofs: Map<string, EgressProof>;
}): EgressEvidence | undefined {
  if (!scopeKey || !eventId) return undefined;
  let redactedValues = 0;
  let survivingValues = 0;
  let ambiguousEntityLinks = 0;
  let screening: EgressProof["screening"] = protectedRequest ? "completed" : "not_configured";
  const labels = new Map<string, EgressProof["labels"][number]>();
  let finished = false;
  const addLabels = (hits: readonly ProtectionHit[], field: "redactedValues" | "survivingValues") => {
    for (const hit of hits) {
      const key = JSON.stringify([hit.name, hit.source, hit.plugin ?? "", hit.kind ?? "", hit.confidence ?? ""]);
      const current = labels.get(key) ?? { ...hit, redactedValues: 0, survivingValues: 0 };
      current[field] = (current[field] ?? 0) + 1;
      labels.set(key, current);
    }
  };
  return {
    record(redaction) {
      redactedValues += redaction.count;
      survivingValues += redaction.leaks;
      ambiguousEntityLinks += redaction.ambiguousEntityLinks;
      addLabels(redaction.hits, "redactedValues");
      addLabels(redaction.leakHits, "survivingValues");
    },
    detectorUnavailable() {
      screening = "detector_unavailable";
    },
    finish(outcome, model = "unknown") {
      if (finished) return;
      finished = true;
      pruneEgressProofs(proofs);
      proofs.set(egressProofKey(scopeKey, eventId), {
        eventId,
        at: new Date().toISOString(),
        outcome,
        screening,
        model,
        redactedValues,
        survivingValues,
        ambiguousEntityLinks,
        labels: [...labels.values()],
      });
    },
  };
}

function egressEventIdFrom(c: Context): string | undefined {
  const value = c.req.header(FICTA_EGRESS_EVENT_HEADER)?.trim();
  return value && /^[0-9a-f]{8}-[0-9a-f-]{27,64}$/i.test(value) ? value : undefined;
}

function egressProofKey(scopeKey: string, eventId: string): string {
  return `${scopeKey}\u0000${eventId}`;
}

function pruneEgressProofs(proofs: Map<string, EgressProof>): void {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [key, proof] of proofs) {
    if (Date.parse(proof.at) < cutoff) proofs.delete(key);
  }
}

function validateProtectionPreviewRequest(value: unknown): ProtectionPreviewRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Preview body must be an object.");
  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string") throw new Error("Preview text is required.");
  if (Buffer.byteLength(record.text, "utf8") > PROTECTION_PREVIEW_TEXT_MAX) {
    throw new Error("Preview text is too large.");
  }
  if (record.protectedValues !== undefined && !Array.isArray(record.protectedValues)) {
    throw new Error("Protected values must be a list.");
  }
  const raw = (record.protectedValues ?? []) as unknown[];
  if (raw.length > PROTECTION_PREVIEW_VALUES_MAX) throw new Error("Too many protected values for one chat.");
  const seen = new Set<string>();
  const protectedValues: string[] = [];
  let protectedValueBytes = 0;
  for (const entry of raw) {
    if (typeof entry !== "string") throw new Error("Every protected value must be text.");
    const normalized = entry.trim();
    if (!normalized || normalized.length > PROTECTION_PREVIEW_VALUE_MAX) {
      throw new Error("A protected value is empty or too long.");
    }
    if (seen.has(normalized)) continue;
    protectedValueBytes += Buffer.byteLength(normalized, "utf8");
    if (protectedValueBytes > PROTECTION_PREVIEW_VALUES_BYTES_MAX) {
      throw new Error("Protected values are too large for one chat.");
    }
    seen.add(normalized);
    protectedValues.push(normalized);
  }
  return { text: record.text, protectedValues };
}

function userProtectedValue(value: string): ProtectedValue {
  return {
    name: "USER_SELECTED",
    value,
    source: "gateway-user",
    plugin: "gateway-preview",
    kind: "custom",
    confidence: "exact",
  };
}

function protectionPreviewFindings(occurrences: readonly ProtectionTraceOccurrence[]): ProtectionPreviewFinding[] {
  return occurrences
    .filter((occurrence) => occurrence.leaf === 0)
    .map(({ leaf: _leaf, ...occurrence }) => occurrence)
    .sort((a, b) => a.start - b.start || b.end - a.end);
}

function pruneProtectionTickets(tickets: Map<string, ProtectionTicket>, now: number): void {
  for (const [ticket, prepared] of tickets) if (prepared.expiresAt <= now) tickets.delete(ticket);
  while (tickets.size >= PROTECTION_TICKETS_MAX) {
    const oldest = tickets.keys().next().value;
    if (oldest === undefined) break;
    tickets.delete(oldest);
  }
}

function pruneScopeProtectionTickets(tickets: Map<string, ProtectionTicket>, scopeKey: string): void {
  const scoped = [...tickets].filter(([, prepared]) => prepared.scopeKey === scopeKey);
  while (scoped.length >= PROTECTION_TICKETS_PER_SCOPE_MAX) {
    const oldest = scoped.shift();
    if (!oldest) break;
    tickets.delete(oldest[0]);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Bind a preview capability to the current user message in the real provider body. Looking only at
 * the last user message prevents a reviewed phrase in transcript history from authorizing a changed
 * new prompt. Gateway currently emits OpenAI Responses/Chat and Anthropic message arrays; the small
 * structural adapter below intentionally rejects unknown shapes rather than weakening the binding.
 */
function requestContainsReviewedText(body: string, expectedSha256: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return sha256(body) === expectedSha256;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  const conversation = Array.isArray(record.input)
    ? record.input
    : Array.isArray(record.messages)
      ? record.messages
      : undefined;
  if (!conversation) return typeof record.input === "string" && sha256(record.input) === expectedSha256;
  for (let index = conversation.length - 1; index >= 0; index--) {
    const message = conversation[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const messageRecord = message as Record<string, unknown>;
    if (messageRecord.role !== "user") continue;
    return textParts(messageRecord.content).some((text) => sha256(text) === expectedSha256);
  }
  return false;
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const record = part as Record<string, unknown>;
    if (typeof record.text === "string") parts.push(record.text);
    else if (typeof record.content === "string") parts.push(record.content);
  }
  return parts;
}

interface QueryRedaction extends SurfaceRedaction {
  search: string;
}

/** Values-free redaction proof for first-party/admin UIs. */
function protectionStatsResponse(stats: ProtectionStats, url: URL): ProtectionStatsOk {
  const limit = protectionStatsLimit(url.searchParams.get("limit"));
  const snapshot = stats.snapshot();
  return {
    ok: true,
    service: "ficta",
    stats: {
      ...snapshot,
      events: snapshot.events.slice(-limit).reverse(),
    },
  };
}

function protectionStatsLimit(raw: string | null): number {
  if (raw === null || raw.trim() === "") return DEFAULT_PROTECTION_STATS_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PROTECTION_STATS_LIMIT;
  return Math.min(MAX_PROTECTION_STATS_LIMIT, Math.floor(n));
}

function isRestorableContentType(contentType: string): boolean {
  const type = contentTypeBase(contentType);
  return type.startsWith("text/") || type.includes("json") || type.includes("event-stream");
}

function isEventStreamContentType(contentType: string): boolean {
  return contentTypeBase(contentType) === "text/event-stream";
}

function isJsonContentType(contentType: string): boolean {
  const base = contentTypeBase(contentType);
  // Stream-framed JSON (newline-delimited / json-seq) is not a single JSON document — buffering it
  // would defeat streaming and JSON.parse would fail, so it must fall through to the stream restore.
  if (base.includes("ndjson") || base.includes("json-seq") || base.includes("jsonl")) return false;
  return base === "application/json" || base.endsWith("+json");
}

/**
 * Restore a fully-buffered body by content type: JSON-aware where possible, raw text otherwise.
 * The wire routes tool-call arguments through the restore-into-tools withholding policy — a
 * non-streaming tool call must not receive real secrets any more than a streamed one.
 */
function restoreBufferedBody(
  scope: RequestScope,
  wire: Wire,
  contentType: string,
  body: string,
  opts?: Parameters<RequestScope["restoreText"]>[1],
): string {
  return isJsonContentType(contentType) ? scope.restoreJson(body, wire, opts) : scope.restoreText(body, opts);
}

/**
 * Redact registered values from a query string. URL.search is percent-encoded, so a stored
 * plaintext value (e.g. one containing a space or `/`) only matches once each parameter is decoded;
 * we decode per parameter to redact, but re-encode only the parameters we actually changed and keep
 * every other parameter's wire bytes verbatim — re-encoding the whole query would normalize the
 * encoding of untouched, possibly signature-sensitive parameters.
 */
async function redactQueryString(scope: RequestScope, url: URL, traceValues: boolean): Promise<QueryRedaction> {
  const raw = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  if (!raw) return { search: url.search, ...emptyRedaction() };

  const total = emptyRedaction();
  // Sequential (not Promise.all): parameters are few, and detection may hit a sidecar — keeping the
  // shared `total` mutations ordered avoids any interleaving surprises.
  const segments: string[] = [];
  for (const segment of raw.split("&")) {
    const eq = segment.indexOf("=");
    const rawKey = eq === -1 ? segment : segment.slice(0, eq);
    const rawValue = eq === -1 ? undefined : segment.slice(eq + 1);

    const redactedKey = await scope.redactTextDetailed(decodeQueryComponent(rawKey), {
      path: url.pathname,
      traceValues,
    });
    addRedaction(total, redactedKey);
    const outKey = redactedKey.count > 0 ? encodeURIComponent(redactedKey.text) : rawKey;

    if (rawValue === undefined) {
      segments.push(outKey);
      continue;
    }

    const redactedValue = await scope.redactTextDetailed(decodeQueryComponent(rawValue), {
      path: url.pathname,
      traceValues,
    });
    addRedaction(total, redactedValue);
    const outValue = redactedValue.count > 0 ? encodeURIComponent(redactedValue.text) : rawValue;

    segments.push(`${outKey}=${outValue}`);
  }

  return { search: `?${segments.join("&")}`, ...total };
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/** Single fail-closed 403 builder so the query/body/header surfaces stay in lockstep. */
function blockedLeakResponse(
  c: Context,
  surface: string,
  leaks: number,
  n?: number,
  leakHits: ProtectionHit[] = [],
): Response {
  // leakHits is category metadata (e.g. name "location", source "pii-presidio"), sanitized by the
  // engine to never carry a raw value — without it a block is undiagnosable from the log line.
  log.error(
    { reqId: n, leaks, surface, leakHits },
    `🛑 BLOCKED — ${leaks} registered value(s) survived ${surface} redaction; refusing to forward`,
  );
  return c.json(
    {
      error: {
        type: "ficta_blocked",
        message: `ficta refused to forward: ${leaks} registered value(s) would have reached the model ${surface}`,
      },
    },
    403,
  );
}

/** Fail-closed 503 for a detector outage: core resolved this detector's policy as blocking. */
function blockedDetectionResponse(c: Context, plugin: string, n?: number): Response {
  log.error(
    { reqId: n, plugin },
    `🛑 BLOCKED — detector "${plugin}" is unavailable and fail-closed is in effect; refusing to forward`,
  );
  return c.json(
    {
      error: {
        type: "ficta_blocked",
        message: `ficta refused to forward: detector "${plugin}" is unavailable and fail-closed is in effect`,
      },
    },
    503,
  );
}

/** Always-blocking response for an internal coordinate/redaction invariant failure. */
function blockedInvariantResponse(c: Context, reason: string, n?: number): Response {
  log.error({ reqId: n, reason }, "🛑 BLOCKED — internal redaction invariant failed; refusing to forward");
  return c.json(
    {
      error: {
        type: "ficta_protection_error",
        message: "ficta refused to forward: an internal redaction safety check failed",
      },
    },
    500,
  );
}

/** WebSocket upgrades that reach the request handler (no upgrade dispatch) get the same 426. */
function refusedWebSocketUpgradeResponse(c: Context, path: string): Response {
  log.info({ path }, "⤴ refused WebSocket upgrade — ficta does not proxy WebSockets; client should retry over HTTP");
  return c.json(
    {
      error: {
        type: "ficta_websocket_unsupported",
        message: "ficta does not proxy WebSocket upgrades; retry the request over HTTP",
      },
    },
    426,
  );
}

/**
 * Buffer the request body while enforcing MAX_ENCODED_BYTES during the read itself — a declared
 * Content-Length over the cap is rejected before any byte is consumed, and a chunked stream is
 * cancelled the moment it exceeds the cap, so an oversized upload can never be buffered whole.
 * Returns null when the body is too large.
 */
async function readBoundedRequestBody(req: Request): Promise<Uint8Array | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_ENCODED_BYTES) return null;
  if (!req.body) return new Uint8Array(await req.arrayBuffer());
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ENCODED_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Fail-closed 413 for a request body larger than the proxy is willing to buffer and screen. */
function refusedRequestTooLargeResponse(c: Context, method: string, path: string): Response {
  log.error(
    { method, path },
    `🛑 BLOCKED — request body exceeds ${MAX_ENCODED_BYTES} bytes; refusing to buffer unscreenable data`,
  );
  return c.json(
    {
      error: {
        type: "ficta_request_too_large",
        message: `ficta refused to forward: request body exceeds ${MAX_ENCODED_BYTES} bytes`,
      },
    },
    413,
  );
}

/** Fail-closed 415 for a request body the proxy could not decode and therefore could not screen. */
function refusedRequestEncodingResponse(
  c: Context,
  err: RequestBodyDecodeError,
  method: string,
  path: string,
): Response {
  log.error(
    { method, path, encoding: err.encoding },
    `🛑 BLOCKED — request body could not be decoded (content-encoding: ${err.encoding}); refusing to forward unscreened bytes`,
  );
  return c.json(
    {
      error: {
        type: "ficta_request_encoding",
        message: `ficta refused to forward: ${err.message}`,
      },
    },
    415,
  );
}

function contentTypeBase(contentType: string): string {
  return contentType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
}

async function redactNonAuthHeaders(
  scope: RequestScope,
  headers: Headers,
  traceValues: boolean,
): Promise<SurfaceRedaction> {
  const total = emptyRedaction();
  for (const [name, value] of [...headers]) {
    if (REQUIRED_AUTH_HEADER_NAMES.has(name.toLowerCase())) continue;
    // Headers do not preserve path-like tokens (unlike the query string): a registered secret inside a
    // slash-path in a header value is redacted, not left intact.
    const redacted = await scope.redactTextDetailed(value, {
      header: name,
      surface: "header",
      preservePaths: false,
      traceValues,
    });
    if (redacted.count > 0) headers.set(name, redacted.text);
    addRedaction(total, redacted);
  }
  return total;
}

function emptyRedaction(): SurfaceRedaction {
  return {
    count: 0,
    leaks: 0,
    ambiguousEntityLinks: 0,
    hits: [],
    leakHits: [],
    traceValues: [],
    traceLeakValues: [],
    traceAmbiguousEntityLinks: [],
  };
}

function addRedaction(
  total: SurfaceRedaction,
  redaction: {
    count: number;
    leaks: number;
    ambiguousEntityLinks?: number;
    hits: ProtectionHit[];
    leakHits: ProtectionHit[];
    traceValues?: ProtectionTraceValue[];
    traceLeakValues?: ProtectionTraceValue[];
    traceAmbiguousEntityLinks?: AmbiguousEntityLinkDiagnostic[];
  },
): void {
  total.count += redaction.count;
  total.leaks += redaction.leaks;
  total.ambiguousEntityLinks += redaction.ambiguousEntityLinks ?? 0;
  total.hits.push(...redaction.hits);
  total.leakHits.push(...redaction.leakHits);
  total.traceValues ??= [];
  total.traceValues.push(...(redaction.traceValues ?? []));
  total.traceLeakValues ??= [];
  total.traceLeakValues.push(...(redaction.traceLeakValues ?? []));
  total.traceAmbiguousEntityLinks ??= [];
  total.traceAmbiguousEntityLinks.push(...(redaction.traceAmbiguousEntityLinks ?? []));
}

function recordProtection(
  stats: ProtectionStats,
  scope: RequestScope,
  traceRedactions: ProtectionTraceRedaction[],
  args: {
    evidence?: EgressEvidence;
    requestId?: number;
    method: string;
    path: string;
    wire: Wire;
    route?: string;
    model?: string;
    surface: ProtectionSurface;
    redaction: SurfaceRedaction;
    blocked: boolean;
  },
): void {
  stats.record({
    requestId: args.requestId,
    method: args.method,
    path: safeStatsMetadata(scope, args.path, "<redacted-path>"),
    wire: args.wire,
    route: args.route,
    model: args.model,
    surface: args.surface,
    redactedValues: args.redaction.count,
    survivingValues: args.redaction.leaks,
    ambiguousEntityLinks: args.redaction.ambiguousEntityLinks,
    blocked: args.blocked,
    redactedHits: args.redaction.hits,
    survivingHits: args.redaction.leakHits,
  });
  args.evidence?.record(args.redaction);
  if (args.blocked) args.evidence?.finish("blocked", args.model);
  const redactedValues = args.redaction.traceValues ?? [];
  const survivingValues = args.redaction.traceLeakValues ?? [];
  const ambiguousLinks = args.redaction.traceAmbiguousEntityLinks ?? [];
  if (redactedValues.length === 0 && survivingValues.length === 0 && ambiguousLinks.length === 0) return;
  traceRedactions.push({
    surface: args.surface,
    blocked: args.blocked,
    redactedCount: args.redaction.count,
    survivingCount: args.redaction.leaks,
    ambiguousEntityLinks: args.redaction.ambiguousEntityLinks,
    redactedValues,
    survivingValues,
    ambiguousLinks,
  });
}

function recordDetectorUnavailable(
  stats: ProtectionStats,
  scope: RequestScope,
  traceRedactions: ProtectionTraceRedaction[],
  args: {
    evidence?: EgressEvidence;
    requestId: number;
    method: string;
    path: string;
    wire: Wire;
    route?: string;
    model?: string;
    surface: ProtectionSurface;
    captureTraceAudit: boolean;
  },
): void {
  stats.record({
    requestId: args.requestId,
    method: args.method,
    path: safeStatsMetadata(scope, args.path, "<redacted-path>"),
    wire: args.wire,
    route: args.route,
    model: args.model,
    surface: args.surface,
    redactedValues: 0,
    survivingValues: 0,
    ambiguousEntityLinks: 0,
    blocked: true,
    blockReason: "detector_unavailable",
  });
  args.evidence?.detectorUnavailable();
  args.evidence?.finish("blocked", args.model);
  writeProtectionTraceAudit(args.requestId, traceRedactions, scope, "blocked", args.captureTraceAudit);
}

function writeProtectionTraceAudit(
  requestId: number,
  redactions: ProtectionTraceRedaction[],
  scope: RequestScope,
  outcome: ProtectionTraceAudit["outcome"],
  traceAudit: boolean,
): void {
  // Skip before traceRestoreDetails() — it SHA-256-hashes every restored value, so on the default
  // (traceAudit off) path this must not run per request. writeTraceAudit() no-ops when off too, but
  // the gate has to be here to avoid the hashing, not just the write.
  if (!traceAudit) return;
  const restore = scope.traceRestoreDetails();
  if (redactions.length === 0 && restore.restored.length === 0 && restore.withheldFromTools.length === 0) return;
  writeTraceAudit(
    requestId,
    {
      version: 1,
      requestId,
      outcome,
      redactions,
      restore,
    } satisfies ProtectionTraceAudit,
    traceAudit,
  );
}

function requestModelFromBody(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const value = JSON.parse(body)?.model;
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  } catch {
    // Non-JSON or malformed request body: no safe model metadata to extract.
  }
  return undefined;
}

function safeRequestModel(scope: RequestScope, original: string | undefined, redacted: string | undefined): string {
  const candidate = redacted ?? original;
  if (!candidate) return "unknown";
  if (original && scope.containsProtectedValue(original)) return "<redacted>";
  if (redacted && SURROGATE_RE.test(redacted)) return "<redacted>";
  if (original && redacted && original !== redacted) return "<redacted>";
  return candidate;
}

function safeStatsMetadata(scope: RequestScope, value: string | undefined, fallback: string): string {
  const text = value?.trim();
  if (!text) return fallback;
  return scope.containsProtectedValue(text) || SURROGATE_RE.test(text) ? fallback : text;
}

// Run directly (`tsx src/server.ts`, `pnpm dev`) → start with the banner.
const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === argv[1];
  } catch {
    return false;
  }
})();
if (isMain) {
  const handle = await startProxy();
  // Run directly (pnpm dev / node --watch), the proxy IS the process — nothing else drives
  // shutdown. Without these handlers the listening socket keeps the event loop alive, so the
  // process ignores SIGINT/SIGTERM and a supervisor (node --watch, turbo) has to force-kill it.
  // Close the server and exit so Ctrl+C, `turbo run dev` teardown, and watch restarts all
  // shut down cleanly.
  const shutdown = () => {
    handle.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
