import type * as React from "react";
import { useEffect, useState } from "react";
import { fetchProxyConfig, type ProxyConfig } from "@/lib/proxy-config";
import { useProtectionStatus } from "@/lib/use-protection-status";
import { cn } from "@/lib/utils";
import { SettingRow } from "./SettingRow";

/**
 * Read-only view of the ficta proxy's effective configuration, for the Admin tab. The data comes
 * from an admin-gated server function (see proxy-config.ts) — it never reaches non-admin browsers.
 * Editing happens where the config lives: FICTA_* env vars or ~/.ficta/config.toml on the proxy
 * host; this section only shows the resulting posture.
 */
export function ProxyConfigSection() {
  const [config, setConfig] = useState<ProxyConfig>();
  const live = useProtectionStatus();

  useEffect(() => {
    let alive = true;
    fetchProxyConfig()
      .then((next) => {
        if (alive) setConfig(next);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setConfig({
          ok: false,
          proxyUrl: "",
          status: "bad_response",
          message: "Could not read ficta proxy configuration.",
          detail: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section aria-label="Proxy configuration">
      <div className="pt-6 pb-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Proxy configuration</h3>
        <p className="pt-1 text-xs text-muted-foreground leading-relaxed">
          Read-only. Set via <code className="font-mono">FICTA_*</code> environment variables or{" "}
          <code className="font-mono">~/.ficta/config.toml</code> on the proxy host.
        </p>
      </div>

      {config === undefined ? (
        <p className="py-4 text-sm text-muted-foreground">Loading proxy configuration…</p>
      ) : !config.ok ? (
        <p className="py-4 text-sm text-muted-foreground">{config.message}</p>
      ) : (
        <ConfigRows config={config.config} piiHealth={live} />
      )}
    </section>
  );
}

function ConfigRows({
  config,
  piiHealth,
}: {
  config: Extract<ProxyConfig, { ok: true }>["config"];
  piiHealth: ReturnType<typeof useProtectionStatus>;
}) {
  const { protection, detection, transport } = config;

  return (
    <>
      <GroupHeading>Protection</GroupHeading>
      <SettingRow label="Fail closed" description="Block the request if a registered secret survives redaction.">
        <Value warn={!protection.failClosed}>{onOff(protection.failClosed)}</Value>
      </SettingRow>
      <SettingRow label="Require registry" description="Refuse to launch with no protected values loaded.">
        <Value>{onOff(protection.requireRegistry)}</Value>
      </SettingRow>
      {protection.globallyDisabled ? (
        <SettingRow label="Globally disabled" description="All protection is bypassed until ficta is re-enabled.">
          <Value warn>Yes</Value>
        </SettingRow>
      ) : null}
      <SettingRow label="Redact inside paths" description="Also redact secrets embedded in path-like tokens.">
        <Value>{onOff(protection.redactPaths)}</Value>
      </SettingRow>
      <SettingRow label="Restore into tool calls" description="Put real values back into tool-call arguments.">
        <Value warn={protection.restoreIntoTools}>{onOff(protection.restoreIntoTools)}</Value>
      </SettingRow>
      {piiHealth?.ok && piiHealth.activity ? (
        <SettingRow
          label="Withheld from tool calls"
          description="Values the model placed in tool arguments that were replaced with placeholders this run."
        >
          <Value warn={piiHealth.activity.withheldFromTools > 0}>{piiHealth.activity.withheldFromTools}</Value>
        </SettingRow>
      ) : null}
      <SettingRow label="Surrogate style" description="Shape of the placeholder tokens sent upstream.">
        <Value>{protection.surrogateStyle}</Value>
      </SettingRow>

      <GroupHeading>Detection</GroupHeading>
      <SettingRow label="PII detection" description="Detect and tokenize PII in chat traffic through this gateway.">
        <Value warn={!detection.pii.standalone}>
          {detection.pii.standalone ? `On · ${detection.pii.configuredBackend} · ${detection.pii.failureMode}` : "Off"}
        </Value>
      </SettingRow>
      {piiHealth?.ok && detection.pii.standalone ? (
        <SettingRow label="PII detector health" description="Live status of the configured detection backend.">
          <Value warn={piiHealth.pii.status === "degraded" || piiHealth.pii.status === "blocking"}>
            {piiHealth.pii.status}
          </Value>
        </SettingRow>
      ) : null}
      <SettingRow label="Secret-shape detection" description="Detect unregistered API keys, JWTs, and private keys.">
        <Value>{onOff(detection.secretShapes.standalone)}</Value>
      </SettingRow>

      <GroupHeading>Transport</GroupHeading>
      <SettingRow label="Listen address" description="Where the proxy accepts local traffic.">
        <Value mono>
          {transport.host}:{transport.port}
        </Value>
      </SettingRow>
      <SettingRow label="Anthropic upstream">
        <Value mono>{transport.upstreams.anthropic}</Value>
      </SettingRow>
      <SettingRow label="OpenAI upstream">
        <Value mono>{transport.upstreams.openai}</Value>
      </SettingRow>
      <SettingRow label="ChatGPT upstream">
        <Value mono>{transport.upstreams.chatgpt}</Value>
      </SettingRow>
      {transport.forcedUpstream ? (
        <SettingRow label="Forced upstream" description="All traffic is routed to this single upstream.">
          <Value mono warn>
            {transport.forcedUpstream}
          </Value>
        </SettingRow>
      ) : null}
      <SettingRow label="Custom upstreams" description="Allow forwarding provider auth to non-default upstreams.">
        <Value warn={transport.allowCustomUpstream}>{transport.allowCustomUpstream ? "Allowed" : "Blocked"}</Value>
      </SettingRow>
      <SettingRow label="Log level">
        <Value>{transport.logLevel}</Value>
      </SettingRow>
      <SettingRow label="Raw body logging" description="Trace level writes real request/response bodies to disk.">
        <Value warn={transport.logBodies}>{onOff(transport.logBodies)}</Value>
      </SettingRow>
      <SettingRow label="Log directory">
        <Value mono>{transport.logDir}</Value>
      </SettingRow>
    </>
  );
}

function GroupHeading({ children }: { children: React.ReactNode }) {
  return <h4 className="pt-5 text-sm font-medium">{children}</h4>;
}

/** Read-only value cell. `warn` uses the app's amber "needs attention" tone (see ProtectionBadge). */
function Value({ children, warn, mono }: { children: React.ReactNode; warn?: boolean; mono?: boolean }) {
  return (
    <span
      className={cn(
        "text-sm break-all",
        mono && "font-mono text-xs",
        warn ? "font-medium text-amber-700 dark:text-amber-300" : "text-foreground",
      )}
    >
      {children}
    </span>
  );
}

function onOff(value: boolean): string {
  return value ? "On" : "Off";
}
