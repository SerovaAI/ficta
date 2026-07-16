import { useRouter } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RETENTION_DAYS_MAX, updateInstanceSettings } from "@/lib/storage/settings";
import type { InstanceSettings } from "@/lib/storage/types";
import { SettingRow } from "./SettingRow";

export function RetentionSettingsSection({ settings }: { settings: InstanceSettings }) {
  const router = useRouter();
  const enabled = settings.deletedThreadRecoveryDays !== undefined && settings.recordsAuditRetentionDays !== undefined;
  const [recoveryDays, setRecoveryDays] = useState(String(settings.deletedThreadRecoveryDays ?? 30));
  const [auditDays, setAuditDays] = useState(String(settings.recordsAuditRetentionDays ?? 365));
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setRecoveryDays(String(settings.deletedThreadRecoveryDays ?? 30));
    setAuditDays(String(settings.recordsAuditRetentionDays ?? 365));
  }, [settings.deletedThreadRecoveryDays, settings.recordsAuditRetentionDays]);

  const save = async (nextEnabled: boolean) => {
    setSaving(true);
    setError("");
    try {
      const recovery = Number(recoveryDays);
      const audit = Number(auditDays);
      await updateInstanceSettings({
        data: nextEnabled
          ? { deletedThreadRecoveryDays: recovery, recordsAuditRetentionDays: audit }
          : { deletedThreadRecoveryDays: undefined },
      });
      setAcknowledged(false);
      await router.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save deleted-chat recovery settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <div className="border-b border-border px-1 py-5">
        <h2 className="font-semibold text-base">Deleted-chat recovery</h2>
        <p className="mt-1 max-w-2xl text-muted-foreground text-sm">
          Optional recovery for chats users remove from their history. This is not a legal hold or a complete records
          schedule.
        </p>
      </div>

      <SettingRow
        label="Recovery window"
        description="Starts when a user deletes a chat. Existing retained chats keep their original purge date."
      >
        <DayInput value={recoveryDays} onChange={setRecoveryDays} disabled={saving} />
      </SettingRow>
      <SettingRow
        label="Audit evidence"
        description="Values-free lifecycle and egress evidence. Must be at least as long as recovery."
      >
        <DayInput value={auditDays} onChange={setAuditDays} disabled={saving} />
      </SettingRow>

      <div className="border-b border-border px-1 py-5">
        <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/40 p-4">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 text-sm">
            <p className="font-medium">Live-database retention is only one copy.</p>
            <p className="mt-1 text-muted-foreground">
              Backups, model-provider storage, and optional raw proxy traces follow separate operator policies. The
              purge job cannot remove those copies.
            </p>
            {!enabled ? (
              <label htmlFor="retention-operator-ack" className="mt-3 flex cursor-pointer items-start gap-2.5">
                <Checkbox
                  id="retention-operator-ack"
                  checked={acknowledged}
                  onCheckedChange={(checked) => setAcknowledged(checked === true)}
                />
                <span>I have aligned backup, provider, and trace retention for this deployment.</span>
              </label>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 px-1 py-5">
        <Button disabled={saving || (!enabled && !acknowledged)} onClick={() => void save(true)}>
          {saving ? "Saving…" : enabled ? "Save policy" : "Enable recovery"}
        </Button>
        {enabled ? (
          <Button variant="outline" disabled={saving} onClick={() => void save(false)}>
            Disable for future deletions
          </Button>
        ) : null}
        <span className="text-muted-foreground text-sm">
          {enabled ? "Enabled" : "Disabled — deletion remains permanent after Undo."}
        </span>
        {error ? (
          <p className="w-full text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function DayInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        max={RETENTION_DAYS_MAX}
        value={value}
        disabled={disabled}
        className="w-28"
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="text-muted-foreground text-sm">days</span>
    </div>
  );
}
