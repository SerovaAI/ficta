import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  type EditableProxyConfigKey,
  type EditableProxyConfigPatch,
  type EditableProxyConfigValues,
  fetchProxyConfig,
  PII_BACKEND_NAMES,
  type PiiBackendName,
  type ProxyConfig,
  updateProxyConfig,
  updateRuntimeTraceCapture,
} from "@/lib/proxy-config";
import { useProtectionStatus } from "@/lib/use-protection-status";
import { cn } from "@/lib/utils";
import { SettingRow } from "./SettingRow";

type SaveStatus = "idle" | "saving" | "saved" | "error";
type TextConfigKey = Extract<EditableProxyConfigKey, "piiPresidioUrl" | "piiOpenmedUrl">;

const TEXT_SAVE_DELAY_MS = 600;

const PII_BACKEND_LABELS: Record<PiiBackendName, { label: string; description: string }> = {
  regex: {
    label: "Regex",
    description: "In-process emails, SSNs, and cards.",
  },
  presidio: {
    label: "Presidio",
    description: "Names, addresses, orgs, and phones via sidecar.",
  },
  openmed: {
    label: "OpenMed",
    description: "Medical and PHI-style identifiers via sidecar.",
  },
};

/**
 * Admin editor for the ficta proxy's safety posture. Reads and writes go through admin-gated server
 * functions (see proxy-config.ts); the browser never talks directly to the loopback proxy.
 */
export function ProxyConfigSection() {
  const [config, setConfig] = useState<ProxyConfig>();
  const [draft, setDraft] = useState<EditableProxyConfigValues>();
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState("Could not save proxy configuration.");
  const [traceSaveStatus, setTraceSaveStatus] = useState<SaveStatus>("idle");
  const [traceSaveError, setTraceSaveError] = useState("Could not update trace capture.");
  const saveSeq = useRef(0);
  const textTimers = useRef<Partial<Record<TextConfigKey, number>>>({});
  const pendingTextValues = useRef<Partial<Record<TextConfigKey, string>>>({});
  const live = useProtectionStatus();

  useEffect(() => {
    let alive = true;
    fetchProxyConfig()
      .then((next) => {
        if (!alive) return;
        setConfig(next);
        if (next.ok) setDraft(next.edit.values);
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

  useEffect(() => {
    if (!config?.ok || !config.config.transport.traceCapture.expiresAt) return;
    const delay = Date.parse(config.config.transport.traceCapture.expiresAt) - Date.now();
    if (delay <= 0) {
      setConfig(withExpiredTraceCapture(config));
      return;
    }
    const timer = window.setTimeout(() => {
      setConfig((current) => (current?.ok ? withExpiredTraceCapture(current) : current));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [config]);

  useEffect(() => {
    return () => {
      for (const timer of Object.values(textTimers.current)) {
        if (timer !== undefined) window.clearTimeout(timer);
      }
    };
  }, []);

  const savePatch = async (
    patch: EditableProxyConfigPatch,
    options: {
      pendingText?: { key: TextConfigKey; value: string };
      revert?: { key: EditableProxyConfigKey; value: EditableProxyConfigValues[EditableProxyConfigKey] };
    } = {},
  ) => {
    const seq = saveSeq.current + 1;
    saveSeq.current = seq;
    setSaveStatus("saving");
    setSaveError("Could not save proxy configuration.");

    try {
      const result = await updateProxyConfig({ data: patch });
      if (saveSeq.current !== seq) return;

      if (!result.ok) {
        if (options.revert) {
          const { key, value } = options.revert;
          setDraft((current) => (current ? { ...current, [key]: value } : current));
        }
        setSaveStatus("error");
        setSaveError(result.message);
        return;
      }

      if (
        options.pendingText !== undefined &&
        pendingTextValues.current[options.pendingText.key] === options.pendingText.value
      ) {
        delete pendingTextValues.current[options.pendingText.key];
      }
      setConfig((current) => (current?.ok ? { ...current, edit: result.edit } : current));
      setDraft((current) => {
        const pending = pendingTextValues.current;
        return current && Object.keys(pending).length > 0 ? { ...result.edit.values, ...pending } : result.edit.values;
      });
      setSaveStatus("saved");
    } catch (err) {
      if (saveSeq.current !== seq) return;
      if (options.revert) {
        const { key, value } = options.revert;
        setDraft((current) => (current ? { ...current, [key]: value } : current));
      }
      setSaveStatus("error");
      setSaveError(err instanceof Error ? err.message : "Could not save proxy configuration.");
    }
  };

  const changeField = <K extends EditableProxyConfigKey>(
    key: K,
    value: EditableProxyConfigValues[K],
    options: { debounce?: boolean } = {},
  ) => {
    if (!draft || draft[key] === value) return;
    const previous = draft[key];
    const next = { ...draft, [key]: value };
    setDraft(next);
    setSaveError("Could not save proxy configuration.");

    if (options.debounce) {
      if (!isTextConfigKey(key)) return;
      saveSeq.current += 1;
      if (textTimers.current[key] !== undefined) window.clearTimeout(textTimers.current[key]);
      pendingTextValues.current[key] = String(value);
      setSaveStatus("saving");
      textTimers.current[key] = window.setTimeout(() => {
        delete textTimers.current[key];
        void savePatch({ [key]: value } as EditableProxyConfigPatch, {
          pendingText: { key, value: String(value) },
        });
      }, TEXT_SAVE_DELAY_MS);
      return;
    }

    void savePatch({ [key]: value } as EditableProxyConfigPatch, { revert: { key, value: previous } });
  };

  const changeRuntimeTraceCapture = async (enabled: boolean) => {
    setTraceSaveStatus("saving");
    setTraceSaveError("Could not update trace capture.");
    try {
      const result = await updateRuntimeTraceCapture({ data: { enabled } });
      if (!result.ok) {
        setTraceSaveStatus("error");
        setTraceSaveError(result.message);
        return;
      }
      setConfig((current) =>
        current?.ok
          ? {
              ...current,
              config: {
                ...current.config,
                transport: {
                  ...current.config.transport,
                  logBodies: result.traceCapture.enabled,
                  traceCapture: result.traceCapture,
                },
              },
            }
          : current,
      );
      setTraceSaveStatus("saved");
    } catch (err) {
      setTraceSaveStatus("error");
      setTraceSaveError(err instanceof Error ? err.message : "Could not update trace capture.");
    }
  };

  return (
    <section aria-label="Proxy configuration">
      <div className="pt-6 pb-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Proxy configuration</h3>
        <p className="pt-1 text-xs text-muted-foreground leading-relaxed">
          Persistent safety settings are written to <code className="font-mono">config.toml</code> and require a proxy
          restart. Runtime trace capture applies immediately.
        </p>
      </div>

      {config === undefined ? (
        <p className="py-4 text-sm text-muted-foreground">Loading proxy configuration…</p>
      ) : !config.ok ? (
        <p className="py-4 text-sm text-muted-foreground">{config.message}</p>
      ) : draft === undefined ? (
        <p className="py-4 text-sm text-muted-foreground">Loading editable configuration…</p>
      ) : (
        <ConfigEditor
          config={config}
          draft={draft}
          onFieldChange={changeField}
          piiHealth={live}
          saveStatus={saveStatus}
          saveError={saveError}
          traceSaveStatus={traceSaveStatus}
          traceSaveError={traceSaveError}
          onTraceCaptureChange={changeRuntimeTraceCapture}
        />
      )}
    </section>
  );
}

function ConfigEditor({
  config,
  draft,
  onFieldChange,
  piiHealth,
  saveStatus,
  saveError,
  traceSaveStatus,
  traceSaveError,
  onTraceCaptureChange,
}: {
  config: Extract<ProxyConfig, { ok: true }>;
  draft: EditableProxyConfigValues;
  onFieldChange: <K extends EditableProxyConfigKey>(
    key: K,
    value: EditableProxyConfigValues[K],
    options?: { debounce?: boolean },
  ) => void;
  piiHealth: ReturnType<typeof useProtectionStatus>;
  saveStatus: SaveStatus;
  saveError: string;
  traceSaveStatus: SaveStatus;
  traceSaveError: string;
  onTraceCaptureChange: (enabled: boolean) => void;
}) {
  const { detection, transport } = config.config;
  const edit = config.edit;
  const disabled = edit.disabled;
  const set = <K extends EditableProxyConfigKey>(key: K, value: EditableProxyConfigValues[K]) => {
    onFieldChange(key, value);
  };
  const toggleBackend = (backend: PiiBackendName, checked: boolean) => {
    const next = new Set(draft.piiBackends);
    if (checked) next.add(backend);
    else next.delete(backend);
    set("piiBackends", orderedBackends(next));
  };

  return (
    <>
      {edit.disabled ? (
        <p className="py-3 text-sm text-amber-700 dark:text-amber-300">
          Persistent config is disabled with <code className="font-mono">FICTA_CONFIG_FILE=0</code>. Edit proxy
          environment variables and restart instead.
        </p>
      ) : null}
      {edit.restartRequired ? (
        <p className="py-3 text-sm text-amber-700 dark:text-amber-300">
          Saved proxy config differs from the running process. Restart the proxy to apply the saved settings.
        </p>
      ) : null}

      <GroupHeading>Protection</GroupHeading>
      <SettingRow label="Fail closed" description="Block the request if a registered secret survives redaction.">
        <BooleanControl
          id="proxy-fail-closed"
          checked={draft.failClosed}
          disabled={isDisabled("failClosed", edit, disabled)}
          onChange={(checked) => set("failClosed", checked)}
          locked={edit.locked.failClosed}
        />
      </SettingRow>
      <SettingRow
        label="Restore into tool calls"
        description="Which redacted values are put back into tool-call arguments: detected (locally-read content only, registry secrets withheld), all, or none."
      >
        <SelectControl
          value={draft.restoreIntoTools}
          disabled={isDisabled("restoreIntoTools", edit, disabled)}
          onChange={(value) => set("restoreIntoTools", value as EditableProxyConfigValues["restoreIntoTools"])}
          locked={edit.locked.restoreIntoTools}
          options={[
            ["detected", "Detected (default)"],
            ["all", "All"],
            ["none", "None"],
          ]}
        />
      </SettingRow>
      <SettingRow label="Surrogate style" description="Placeholder token shape sent upstream.">
        <div className="space-y-2">
          <SelectControl
            value={draft.surrogateStyle}
            disabled={isDisabled("surrogateStyle", edit, disabled)}
            onChange={(value) => set("surrogateStyle", value as EditableProxyConfigValues["surrogateStyle"])}
            locked={edit.locked.surrogateStyle}
            options={[
              ["opaque", "Opaque - FICTA_<hex>"],
              ["typed", "Typed - FICTA_<TYPE>_<hex>"],
            ]}
          />
          <SurrogateStyleDetail />
        </div>
      </SettingRow>

      <GroupHeading>Detection</GroupHeading>
      <SettingRow label="PII detection" description="Detect and tokenize PII in chat traffic through this gateway.">
        <BooleanControl
          id="proxy-pii-enabled"
          checked={draft.piiEnabled}
          disabled={isDisabled("piiEnabled", edit, disabled)}
          onChange={(checked) => set("piiEnabled", checked)}
          locked={edit.locked.piiEnabled}
        />
      </SettingRow>
      <SettingRow
        label="PII backends"
        description="Select one or more detectors for chat traffic through this gateway."
      >
        <BackendCheckboxGroup
          selected={draft.piiBackends}
          disabled={isDisabled("piiBackends", edit, disabled)}
          locked={edit.locked.piiBackends}
          onChange={toggleBackend}
        />
      </SettingRow>
      {draft.piiBackends.includes("presidio") ? (
        <SettingRow label="Presidio URL" htmlFor="proxy-presidio-url" description="Analyzer endpoint used by Presidio.">
          <div className="space-y-1">
            <Input
              id="proxy-presidio-url"
              value={draft.piiPresidioUrl}
              disabled={isDisabled("piiPresidioUrl", edit, disabled)}
              className="w-64 font-mono text-xs"
              onChange={(event) => onFieldChange("piiPresidioUrl", event.target.value, { debounce: true })}
            />
            <LockedText>{edit.locked.piiPresidioUrl}</LockedText>
          </div>
        </SettingRow>
      ) : null}
      {draft.piiBackends.includes("openmed") ? (
        <SettingRow label="OpenMed URL" htmlFor="proxy-openmed-url" description="REST endpoint used by OpenMed.">
          <div className="space-y-1">
            <Input
              id="proxy-openmed-url"
              value={draft.piiOpenmedUrl}
              disabled={isDisabled("piiOpenmedUrl", edit, disabled)}
              className="w-64 font-mono text-xs"
              onChange={(event) => onFieldChange("piiOpenmedUrl", event.target.value, { debounce: true })}
            />
            <LockedText>{edit.locked.piiOpenmedUrl}</LockedText>
          </div>
        </SettingRow>
      ) : null}
      <SettingRow label="PII outage policy" description="Block sends when the selected PII backend is unavailable.">
        <BooleanControl
          id="proxy-pii-fail-closed"
          checked={draft.piiFailClosed}
          disabled={isDisabled("piiFailClosed", edit, disabled)}
          onChange={(checked) => set("piiFailClosed", checked)}
          locked={edit.locked.piiFailClosed}
        />
      </SettingRow>
      {piiHealth?.ok && detection.pii.standalone ? (
        <SettingRow label="PII detector health" description="Live status of the configured detection backend.">
          <Value warn={piiHealth.pii.status === "degraded" || piiHealth.pii.status === "blocking"}>
            {piiHealth.pii.status}
          </Value>
        </SettingRow>
      ) : null}
      <SettingRow label="Secret-shape detection" description="Detect unregistered API keys, JWTs, and private keys.">
        <BooleanControl
          id="proxy-secret-shapes-enabled"
          checked={draft.secretShapesEnabled}
          disabled={isDisabled("secretShapesEnabled", edit, disabled)}
          onChange={(checked) => set("secretShapesEnabled", checked)}
          locked={edit.locked.secretShapesEnabled}
        />
      </SettingRow>

      <GroupHeading>Upstream policy</GroupHeading>
      <SettingRow label="Custom upstreams" description="Allow forwarding provider auth to non-default upstreams.">
        <BooleanControl
          id="proxy-allow-custom-upstream"
          checked={draft.allowCustomUpstream}
          disabled={isDisabled("allowCustomUpstream", edit, disabled)}
          onChange={(checked) => set("allowCustomUpstream", checked)}
          locked={edit.locked.allowCustomUpstream}
        />
      </SettingRow>

      <InlineStatus status={saveStatus} error={saveError} />

      <GroupHeading>Transport</GroupHeading>
      <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
        Raw trace capture can contain credentials, personal information, prompts, tool arguments, and restored values.
        Enable it only while actively debugging and keep the capture directory private.
      </div>
      <SettingRow
        label="Runtime trace capture"
        description={
          transport.traceCapture.enabled && transport.traceCapture.expiresAt
            ? `Active until ${formatExpiry(transport.traceCapture.expiresAt)}. It will also turn off when the proxy restarts.`
            : "Disabled. When enabled, it automatically turns off after 30 minutes or when the proxy restarts."
        }
      >
        <BooleanControl
          id="proxy-runtime-trace-capture"
          checked={transport.traceCapture.enabled}
          disabled={traceSaveStatus === "saving"}
          onChange={onTraceCaptureChange}
        />
      </SettingRow>
      <RuntimeTraceStatus status={traceSaveStatus} error={traceSaveError} enabled={transport.traceCapture.enabled} />
      <SettingRow label="Trace capture directory">
        <Value mono warn={transport.traceCapture.enabled}>
          {transport.logDir}
        </Value>
      </SettingRow>
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
      <SettingRow label="Log level">
        <Value>{transport.logLevel}</Value>
      </SettingRow>
      <SettingRow label="Raw body logging" description="Effective runtime state for new, explicitly selected chats.">
        <Value warn={transport.logBodies}>{onOff(transport.logBodies)}</Value>
      </SettingRow>
      <SettingRow label="Log directory">
        <Value mono>{transport.logDir}</Value>
      </SettingRow>
    </>
  );
}

function InlineStatus({ status, error }: { status: SaveStatus; error: string }) {
  if (status === "idle") return null;
  if (status === "saved") {
    return <p className="py-4 text-right text-xs text-muted-foreground">Saved. Restart the proxy to apply changes.</p>;
  }
  return (
    <p className={cn("py-4 text-right text-xs", status === "error" ? "text-destructive" : "text-muted-foreground")}>
      {status === "saving" ? "Saving…" : error}
    </p>
  );
}

function RuntimeTraceStatus({ status, error, enabled }: { status: SaveStatus; error: string; enabled: boolean }) {
  if (status === "idle") return null;
  if (status === "saved") {
    return (
      <p className="py-4 text-right text-xs text-muted-foreground">
        {enabled ? "Enabled immediately for 30 minutes." : "Disabled immediately for new requests."}
      </p>
    );
  }
  return (
    <p className={cn("py-4 text-right text-xs", status === "error" ? "text-destructive" : "text-muted-foreground")}>
      {status === "saving" ? "Updating…" : error}
    </p>
  );
}

function SurrogateStyleDetail() {
  return (
    <p className="max-w-72 text-xs leading-relaxed text-muted-foreground sm:text-right">
      Maps to <code className="font-mono">[surrogate] style</code> /{" "}
      <code className="font-mono">FICTA_SURROGATE_STYLE</code>. Opaque hides the value type; typed keeps a grammar cue
      like <code className="font-mono">FICTA_PERSON_...</code> or <code className="font-mono">FICTA_SSN_...</code>.
      Restore behavior is unchanged.
    </p>
  );
}

function BackendCheckboxGroup({
  selected,
  disabled,
  locked,
  onChange,
}: {
  selected: PiiBackendName[];
  disabled?: boolean;
  locked?: string;
  onChange: (backend: PiiBackendName, checked: boolean) => void;
}) {
  return (
    <div className="space-y-2">
      {PII_BACKEND_NAMES.map((backend) => {
        const id = `proxy-pii-backend-${backend}`;
        const meta = PII_BACKEND_LABELS[backend];
        return (
          <label
            key={backend}
            htmlFor={id}
            className="flex cursor-pointer items-start justify-end gap-2.5 text-right text-sm [@media(pointer:coarse)]:min-h-11"
          >
            <span>
              <span className={selected.includes(backend) ? "font-medium" : "text-muted-foreground"}>{meta.label}</span>
              <span className="block max-w-64 text-xs leading-relaxed text-muted-foreground">{meta.description}</span>
            </span>
            <Checkbox
              id={id}
              checked={selected.includes(backend)}
              disabled={disabled}
              onCheckedChange={(state) => onChange(backend, state === true)}
            />
          </label>
        );
      })}
      <LockedText>{locked}</LockedText>
    </div>
  );
}

function BooleanControl({
  id,
  checked,
  disabled,
  locked,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  locked?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex cursor-pointer items-center justify-end gap-2.5 text-sm">
        <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
        <span className={checked ? "font-medium" : "text-muted-foreground"}>{onOff(checked)}</span>
      </label>
      <LockedText>{locked}</LockedText>
    </div>
  );
}

function SelectControl({
  value,
  options,
  disabled,
  locked,
  onChange,
}: {
  value: string;
  options: Array<[string, string]>;
  disabled?: boolean;
  locked?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <select
        value={value}
        disabled={disabled}
        className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([optionValue, label]) => (
          <option key={optionValue} value={optionValue}>
            {label}
          </option>
        ))}
      </select>
      <LockedText>{locked}</LockedText>
    </div>
  );
}

function LockedText({ children }: { children?: React.ReactNode }) {
  return children ? <p className="max-w-64 text-right text-xs text-muted-foreground">{children}</p> : null;
}

function isDisabled(
  field: EditableProxyConfigKey,
  edit: Extract<ProxyConfig, { ok: true }>["edit"],
  disabled: boolean,
): boolean {
  return disabled || Boolean(edit.locked[field]);
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

function formatExpiry(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function withExpiredTraceCapture(config: Extract<ProxyConfig, { ok: true }>): Extract<ProxyConfig, { ok: true }> {
  return {
    ...config,
    config: {
      ...config.config,
      transport: {
        ...config.config.transport,
        logBodies: false,
        traceCapture: { ...config.config.transport.traceCapture, enabled: false, expiresAt: undefined },
      },
    },
  };
}

function orderedBackends(backends: Set<PiiBackendName>): PiiBackendName[] {
  const ordered = PII_BACKEND_NAMES.filter((backend) => backends.has(backend));
  return ordered.length > 0 ? ordered : ["regex"];
}

function isTextConfigKey(key: EditableProxyConfigKey): key is TextConfigKey {
  return key === "piiPresidioUrl" || key === "piiOpenmedUrl";
}
