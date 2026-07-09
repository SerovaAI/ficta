import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { type HttpBindings, serve } from "@hono/node-server";
import {
  FICTA_CONFIG_PATH,
  FICTA_HEALTH_PATH,
  FICTA_PROTECTION_STATS_PATH,
  FICTA_RESTORE_HIGHLIGHT_END,
  FICTA_RESTORE_HIGHLIGHT_HEADER,
  FICTA_RESTORE_HIGHLIGHT_METADATA,
  FICTA_RESTORE_HIGHLIGHT_START,
  FICTA_SCOPE_HEADER,
  FICTA_STATUS_PATH,
  FICTA_TRACE_CAPTURE_HEADER,
  type ProtectionStatsOk,
  type ProtectionStatusOk,
  type ProxyConfigOk,
} from "@serovaai/ficta-protocol";
import { type Context, Hono } from "hono";
import { loadConfig, resolveTarget, upstreamPolicyIssue } from "./config.js";
import { configPosture } from "./config-posture.js";
import { detectorFailClosed } from "./engine/detection-policy.js";
import { setEngineWarnSink } from "./engine/diagnostics.js";
import { ProtectionEngine } from "./engine/engine.js";
import { withPreservationInstruction } from "./engine/preserve-literals.js";
import { ProtectionStats, type ProtectionStatsSnapshot, type ProtectionSurface } from "./engine/protection-stats.js";
import {
  DetectorUnavailableError,
  type ProtectionHit,
  type ProtectionTraceValue,
  type RedactionEngine,
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
  type PluginDiscovery,
  piiEnabled,
  piiFailClosed,
  type RedactionPlugin,
  type RegistryPolicy,
  registryDiscoveryLines,
  registryPolicyLines,
  secretShapesEnabled,
  selectedBackendNames,
} from "./plugins/index.js";
import {
  applyProxyConfigPatch,
  isLoopbackAddress,
  proxyConfigEditState,
  proxyConfigLockedFields,
} from "./proxy-config-edit.js";

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
  const app = new Hono<{ Bindings: HttpBindings }>();

  app.all("*", async (c) => {
    const url = new URL(c.req.url);
    const method = c.req.method;
    if (url.pathname === FICTA_HEALTH_PATH) return c.json({ ok: true, service: "ficta" });
    if (url.pathname === FICTA_STATUS_PATH) return c.json(await protectionStatus(engine, stats));
    if (url.pathname === FICTA_PROTECTION_STATS_PATH) return c.json(protectionStatsResponse(stats, url));
    // Values-free config posture (see ConfigPosture). Kept separate from FICTA_STATUS_PATH, which the
    // gateway's non-admin protection widget polls: transport config (upstreams, host/port, log dir)
    // is admin-facing, and the gateway gates its fetch server-side. The proxy itself stays
    // auth-free and loopback-bound; this endpoint adds no secrets to expose.
    if (url.pathname === FICTA_CONFIG_PATH) {
      if (method === "GET") {
        const response: ProxyConfigOk = {
          ok: true,
          service: "ficta",
          config: configPosture(cfg),
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
            },
            403,
          );
        }
        let patch: unknown;
        try {
          patch = await c.req.json();
        } catch {
          return c.json(
            { ok: false, service: "ficta", status: "invalid_patch", message: "Config patch must be valid JSON." },
            400,
          );
        }
        const result = applyProxyConfigPatch(cfg, patch, configEditLocks);
        return c.json(result, result.ok ? 200 : result.status === "locked" ? 409 : 400);
      }
      return c.json({ error: { type: "method_not_allowed", message: "Use GET or PATCH for proxy config." } }, 405);
    }

    // Protect every outbound request body, query string, and non-auth header by default.
    // Provider/client paths change, and an "unknown" route can still carry conversation/tool
    // content; exact-match redaction is safe.
    const protect = engine.protecting;
    const wire = wireOf(url.pathname);
    const captureRawBodies = traceCaptureFrom(c, cfg.logBodies);
    const captureTraceAudit = captureRawBodies && cfg.traceAudit;
    const restoreHighlightMarkers =
      captureTraceAudit && c.req.header(FICTA_RESTORE_HIGHLIGHT_HEADER) === "1"
        ? {
            start: FICTA_RESTORE_HIGHLIGHT_START,
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
    const scope = engine.beginRequest(scopeKeyFrom(c));
    const traceRedactions: ProtectionTraceRedaction[] = [];

    let searchToSend = url.search;
    let queryRedaction: SurfaceRedaction | undefined;
    if (protect && searchToSend) {
      const { search: redactedSearch, ...redaction } = await redactQueryString(scope, url, captureTraceAudit);
      queryRedaction = redaction;
      if (redaction.leaks > 0 && cfg.failClosed) {
        const n = logRequest({
          method,
          path: url.pathname,
          body: "",
          target: "<blocked>",
          route: "blocked",
          captureRawBodies,
        });
        recordProtection(stats, scope, traceRedactions, {
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
      const n = logRequest({ method, path: url.pathname, body: "", target: "<blocked>", route, captureRawBodies });
      if (queryRedaction) {
        recordProtection(stats, scope, traceRedactions, {
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
      return c.json({ error: { type: "ficta_upstream_policy", message: upstreamIssue } }, 403);
    }

    const headers = new Headers(c.req.raw.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("accept-encoding");
    headers.delete(FICTA_SCOPE_HEADER); // internal routing metadata — must never reach the upstream vendor
    headers.delete(FICTA_TRACE_CAPTURE_HEADER); // internal trace/audit selector — must never reach upstream
    headers.delete(FICTA_RESTORE_HIGHLIGHT_HEADER); // trace-demo UI hint — must never reach the upstream vendor

    let bodyToSend: string | undefined;
    let n: number;
    let requestModel = "unknown";

    if (method !== "GET" && method !== "HEAD") {
      const bodyText = await c.req.raw.text();
      const originalModel = requestModelFromBody(bodyText);
      n = logRequest({ method, path: url.pathname, body: bodyText, target, route, captureRawBodies });

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
          if (err instanceof DetectorUnavailableError) return blockedDetectionResponse(c, err.plugin, n);
          throw err;
        }
        const redacted = redaction.body;
        requestModel = safeRequestModel(scope, originalModel, requestModelFromBody(redacted));
        if (queryRedaction) {
          recordProtection(stats, scope, traceRedactions, {
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
            const fields = { reqId: n, kept: redaction.count, leaked: redaction.leaks, surface: "body" };
            const msg = `🔒 kept ${redaction.count} body value(s) out of the model${warn}`;
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
      n = logRequest({ method, path: url.pathname, body: "", target, route, captureRawBodies });
      if (queryRedaction) {
        recordProtection(stats, scope, traceRedactions, {
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
      const redaction = await redactNonAuthHeaders(scope, headers, captureTraceAudit);
      if (redaction.leaks > 0 && cfg.failClosed) {
        recordProtection(stats, scope, traceRedactions, {
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
      return c.json({ error: { type: "ficta_upstream_error", message: String(err) } }, 502);
    }

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
      // Persist both counts so withholds are visible beyond this log line (protection-stats.json, /__ficta/status).
      stats.recordRestore({ restoredValues: restored, withheldFromToolsValues: withheld });
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
      log.info(
        {
          url: `http://${bindHost}:${info.port}`,
          clientBaseUrl: `http://${clientHost}:${info.port}`,
          upstreams: cfg.upstreams,
          vault: engine.size,
          failClosed: cfg.failClosed,
          logDir,
          runDir: currentRunDir(),
          rawBodies: cfg.logBodies,
          rawValueAudit: cfg.traceAudit,
        },
        engine.protecting
          ? `🔒 ficta listening on http://${bindHost}:${info.port} — ${engine.size} value(s), redacting up / restoring back`
          : `⚠ ficta listening on http://${bindHost}:${info.port} — NONE loaded, passthrough`,
      );
      // Per-source discovery + policy detail is the old --ficta-verbose report; keep it at debug.
      for (const line of registryDiscoveryLines(
        engine.registry.discoveries,
        "",
        engine.registry.policyExcludedBySource,
      )) {
        log.debug({}, line.trim());
      }
      for (const line of registryPolicyLines(engine.registry.registryPolicy, "")) {
        log.debug({}, `registry policy exclusion: ${line.trim()}`);
      }
      if (keyWarning) log.warn({}, `key warning: ${keyWarning}`);
      resolve({
        port: info.port,
        protectedValues: engine.size,
        registry: engine.registry.discoveries,
        policyExcluded: engine.registry.policyExcluded,
        policyExcludedBySource: engine.registry.policyExcludedBySource,
        registryPolicy: engine.registry.registryPolicy,
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

function traceCaptureFrom(c: Context, globallyEnabled: boolean): boolean {
  return globallyEnabled && c.req.header(FICTA_TRACE_CAPTURE_HEADER)?.trim() !== "0";
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
    protection: {
      enabled: engine.enabled,
      protecting: engine.protecting,
      registeredValues: engine.size,
      policyExcluded: engine.registry.policyExcluded,
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

const DEFAULT_PROTECTION_STATS_LIMIT = 100;
const MAX_PROTECTION_STATS_LIMIT = 500;
const REQUIRED_AUTH_HEADER_NAMES = new Set(["authorization", "proxy-authorization", "x-api-key", "cookie"]);
const SURROGATE_RE = /FICTA_[0-9a-f]{32}/;

interface SurfaceRedaction {
  count: number;
  leaks: number;
  hits: ProtectionHit[];
  leakHits: ProtectionHit[];
  traceValues?: ProtectionTraceValue[];
  traceLeakValues?: ProtectionTraceValue[];
}

interface ProtectionTraceRedaction {
  surface: ProtectionSurface;
  blocked: boolean;
  redactedCount: number;
  survivingCount: number;
  redactedValues: ProtectionTraceValue[];
  survivingValues: ProtectionTraceValue[];
}

interface ProtectionTraceAudit {
  version: 1;
  requestId: number;
  outcome: "blocked" | "completed" | "not-restored" | "upstream-error";
  redactions: ProtectionTraceRedaction[];
  restore: RestoreTraceDetails;
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
  return { count: 0, leaks: 0, hits: [], leakHits: [], traceValues: [], traceLeakValues: [] };
}

function addRedaction(
  total: SurfaceRedaction,
  redaction: {
    count: number;
    leaks: number;
    hits: ProtectionHit[];
    leakHits: ProtectionHit[];
    traceValues?: ProtectionTraceValue[];
    traceLeakValues?: ProtectionTraceValue[];
  },
): void {
  total.count += redaction.count;
  total.leaks += redaction.leaks;
  total.hits.push(...redaction.hits);
  total.leakHits.push(...redaction.leakHits);
  total.traceValues ??= [];
  total.traceValues.push(...(redaction.traceValues ?? []));
  total.traceLeakValues ??= [];
  total.traceLeakValues.push(...(redaction.traceLeakValues ?? []));
}

function recordProtection(
  stats: ProtectionStats,
  scope: RequestScope,
  traceRedactions: ProtectionTraceRedaction[],
  args: {
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
    blocked: args.blocked,
    redactedHits: args.redaction.hits,
    survivingHits: args.redaction.leakHits,
  });
  const redactedValues = args.redaction.traceValues ?? [];
  const survivingValues = args.redaction.traceLeakValues ?? [];
  if (redactedValues.length === 0 && survivingValues.length === 0) return;
  traceRedactions.push({
    surface: args.surface,
    blocked: args.blocked,
    redactedCount: args.redaction.count,
    survivingCount: args.redaction.leaks,
    redactedValues,
    survivingValues,
  });
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
