import { Check, Download, Pencil, Plus, Trash2, Upload, UploadCloud } from "lucide-react";
import type * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseProtectedRegistryImport } from "@/lib/protected-registry-import";
import {
  deleteProtectedRegistryEntry,
  exportProtectedRegistryFile,
  fetchProtectedRegistryEntries,
  importProtectedRegistryEntries,
  type ProtectedRegistryExport,
  type ProtectedRegistryPublish,
  publishProtectedRegistry,
  saveProtectedRegistryEntry,
} from "@/lib/storage/protected-registry";
import {
  PROTECTED_REGISTRY_ENTRY_STATUSES,
  PROTECTED_REGISTRY_ENTRY_TYPES,
  type ProtectedRegistryEntry,
  type ProtectedRegistryEntryInput,
  type ProtectedRegistryEntryStatus,
  type ProtectedRegistryEntryType,
} from "@/lib/storage/types";
import { cn } from "@/lib/utils";

type SaveStatus = "idle" | "saving" | "error";
type Draft = {
  id?: string;
  matterId: string;
  type: ProtectedRegistryEntryType;
  value: string;
  aliases: string;
  status: ProtectedRegistryEntryStatus;
};

const EMPTY_DRAFT: Draft = {
  matterId: "",
  type: "client",
  value: "",
  aliases: "",
  status: "approved",
};

const TYPE_LABELS: Record<ProtectedRegistryEntryType, string> = {
  client: "Client",
  counterparty: "Counterparty",
  person: "Person",
  matter: "Matter",
  case: "Case",
  contract: "Contract",
  account: "Account",
  project: "Project",
  vendor: "Vendor",
  custodian: "Custodian",
  other: "Other",
};

const STATUS_LABELS: Record<ProtectedRegistryEntryStatus, string> = {
  approved: "Approved",
  suggested: "Suggested",
  ignored: "Ignored",
};

export function ProtectedRegistrySection({ showHeader = true }: { showHeader?: boolean } = {}) {
  const [entries, setEntries] = useState<ProtectedRegistryEntry[]>();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [importText, setImportText] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [importStatus, setImportStatus] = useState<SaveStatus>("idle");
  const [exportStatus, setExportStatus] = useState<SaveStatus>("idle");
  const [publishStatus, setPublishStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState("");
  const [exportResult, setExportResult] = useState<ProtectedRegistryExport>();
  const [publishResult, setPublishResult] = useState<ProtectedRegistryPublish>();

  const approvedEntries = useMemo(() => entries?.filter((entry) => entry.status === "approved") ?? [], [entries]);
  const approvedValues = useMemo(
    () =>
      approvedEntries.reduce(
        (total, entry) => total + 1 + entry.aliases.filter((alias) => alias.length >= 4).length,
        0,
      ),
    [approvedEntries],
  );

  useEffect(() => {
    let alive = true;
    fetchProtectedRegistryEntries()
      .then((next) => {
        if (alive) setEntries(next);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setEntries([]);
        setError(err instanceof Error ? err.message : "Could not load registry entries.");
      });
    return () => {
      alive = false;
    };
  }, []);

  const refresh = async () => setEntries(await fetchProtectedRegistryEntries());

  const resetDraft = () => setDraft(EMPTY_DRAFT);

  const submitDraft = async () => {
    setSaveStatus("saving");
    setError("");
    try {
      await saveProtectedRegistryEntry({ data: draftToInput(draft) });
      await refresh();
      resetDraft();
      setSaveStatus("idle");
    } catch (err) {
      setSaveStatus("error");
      setError(err instanceof Error ? err.message : "Could not save registry entry.");
    }
  };

  const remove = async (entry: ProtectedRegistryEntry) => {
    setError("");
    try {
      await deleteProtectedRegistryEntry({ data: { id: entry.id } });
      await refresh();
      if (draft.id === entry.id) resetDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete registry entry.");
    }
  };

  const setEntryStatus = async (entry: ProtectedRegistryEntry, status: ProtectedRegistryEntryStatus) => {
    setError("");
    try {
      await saveProtectedRegistryEntry({ data: { ...entryToInput(entry), status } });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update registry entry.");
    }
  };

  const importRows = async () => {
    const parsed = parseProtectedRegistryImport(importText);
    setWarnings(parsed.warnings);
    if (parsed.entries.length === 0) return;

    setImportStatus("saving");
    setError("");
    try {
      await importProtectedRegistryEntries({ data: parsed.entries });
      await refresh();
      setImportText("");
      setImportStatus("idle");
    } catch (err) {
      setImportStatus("error");
      setError(err instanceof Error ? err.message : "Could not import registry entries.");
    }
  };

  const exportRegistry = async () => {
    setExportStatus("saving");
    setError("");
    try {
      const result = await exportProtectedRegistryFile();
      setExportResult(result);
      setPublishResult(undefined);
      setExportStatus("idle");
    } catch (err) {
      setExportStatus("error");
      setError(err instanceof Error ? err.message : "Could not export registry file.");
    }
  };

  const publishRegistry = async () => {
    setPublishStatus("saving");
    setError("");
    try {
      const result = await publishProtectedRegistry();
      setPublishResult(result);
      setExportResult(undefined);
      setPublishStatus("idle");
    } catch (err) {
      setPublishStatus("error");
      setError(err instanceof Error ? err.message : "Could not publish registry to the proxy.");
    }
  };

  return (
    <section aria-label="Protected registry">
      {showHeader ? (
        <div className="pt-6 pb-1">
          <h3 className="text-sm font-semibold">Protected Registry</h3>
          <p className="pt-1 text-muted-foreground text-xs leading-relaxed">
            Approved values become exact-match protection candidates for the proxy. Suggested rows stay review-only
            until an admin approves them.
          </p>
        </div>
      ) : null}

      <ProtectedRegistrySummary entries={entries} approvedValues={approvedValues} />

      {error ? <p className="py-2 text-destructive text-sm">{error}</p> : null}

      <div className="grid gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
        <ManualEntryForm
          draft={draft}
          onDraftChange={setDraft}
          onCancel={resetDraft}
          onSubmit={submitDraft}
          status={saveStatus}
        />
        <ImportPanel
          value={importText}
          onChange={setImportText}
          warnings={warnings}
          status={importStatus}
          onImport={importRows}
        />
      </div>

      <div className="border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-medium">Publish approved values to the proxy</h4>
            <p className="max-w-3xl pt-1 text-muted-foreground text-xs leading-relaxed">
              Publishes one private file and verifies that the running proxy loaded that exact revision. New values and
              aliases apply immediately. Removed values and metadata-only changes keep their previous behavior until the
              proxy restarts.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={exportRegistry}
              disabled={entries === undefined || exportStatus === "saving" || publishStatus === "saving"}
            >
              <Download className="size-4" aria-hidden />
              {exportStatus === "saving"
                ? "Exporting…"
                : approvedEntries.length === 0
                  ? "Export empty file"
                  : "Export file only"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={publishRegistry}
              disabled={entries === undefined || publishStatus === "saving" || exportStatus === "saving"}
            >
              <UploadCloud className="size-4" aria-hidden />
              {publishStatus === "saving"
                ? "Publishing…"
                : approvedEntries.length === 0
                  ? "Publish empty registry"
                  : "Publish to proxy"}
            </Button>
          </div>
        </div>
        {exportResult ? (
          <p
            className="mt-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed"
            role="status"
          >
            {exportResult.values} value{exportResult.values === 1 ? "" : "s"} written to{" "}
            <code className="break-all font-mono">{exportResult.path}</code>
            {exportResult.skippedAliases > 0 ? `; ${exportResult.skippedAliases} short alias(es) skipped` : ""}
          </p>
        ) : null}
        {publishResult ? (
          <div
            className="mt-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed"
            role="status"
          >
            <p>
              {publishResult.values} value{publishResult.values === 1 ? "" : "s"} written to{" "}
              <code className="break-all font-mono">{publishResult.path}</code>
              {publishResult.skippedAliases > 0 ? `; ${publishResult.skippedAliases} short alias(es) skipped` : ""}
            </p>
            {publishResult.reload.ok ? (
              <>
                <p className="pt-1 text-emerald-600 dark:text-emerald-400">
                  Verified on proxy: now protecting {publishResult.reload.total} value
                  {publishResult.reload.total === 1 ? "" : "s"} (+{publishResult.reload.added} new).
                </p>
                {publishResult.reload.skippedTooShort > 0 ? (
                  <p className="pt-1 text-amber-600 dark:text-amber-400">
                    {publishResult.reload.skippedTooShort} value
                    {publishResult.reload.skippedTooShort === 1 ? " is" : "s are"} shorter than the proxy&apos;s minimum
                    length and NOT protected (FICTA_REGISTRY_MIN_LEN).
                  </p>
                ) : null}
                {publishResult.reload.filesMissing > 0 ? (
                  <p className="pt-1 text-amber-600 dark:text-amber-400">
                    This publish is verified, but {publishResult.reload.filesMissing} other configured registry file
                    {publishResult.reload.filesMissing === 1 ? " is" : "s are"} missing on the proxy
                    (FICTA_REGISTRY_MANAGED_FILE_PATHS).
                  </p>
                ) : null}
              </>
            ) : (
              <p className="pt-1 text-amber-600 dark:text-amber-400">
                File written, but not verified on proxy: {publishResult.reload.message}
              </p>
            )}
          </div>
        ) : null}
      </div>

      <ProtectedRegistryTable
        entries={entries}
        onEdit={setDraftFromEntry(setDraft)}
        onDelete={remove}
        onSetStatus={setEntryStatus}
      />
    </section>
  );
}

function ProtectedRegistrySummary({
  entries,
  approvedValues,
}: {
  entries: ProtectedRegistryEntry[] | undefined;
  approvedValues: number;
}) {
  const approved = entries?.filter((entry) => entry.status === "approved").length ?? 0;
  const suggested = entries?.filter((entry) => entry.status === "suggested").length ?? 0;
  const ignored = entries?.filter((entry) => entry.status === "ignored").length ?? 0;
  return (
    <div className="grid grid-cols-2 gap-2 py-4 sm:grid-cols-4">
      <Metric label="Approved entries" value={entries ? approved : "…"} />
      <Metric label="Suggested entries" value={entries ? suggested : "…"} />
      <Metric label="Ignored entries" value={entries ? ignored : "…"} />
      <Metric label="Exported values" value={entries ? approvedValues : "…"} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="min-w-0 border border-border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="pt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function ManualEntryForm({
  draft,
  onDraftChange,
  onCancel,
  onSubmit,
  status,
}: {
  draft: Draft;
  onDraftChange: (draft: Draft) => void;
  onCancel: () => void;
  onSubmit: () => void;
  status: SaveStatus;
}) {
  const editing = Boolean(draft.id);
  const canSave = draft.value.trim().length > 0 && status !== "saving";
  return (
    <div className="min-w-0">
      <div>
        <h4 className="text-sm font-medium">{editing ? "Edit protected value" : "Protect a value"}</h4>
        <p className="mt-1 max-w-prose text-muted-foreground text-xs leading-relaxed">
          Add the exact name, matter, account, or identifier ficta should redact before prompts leave this workspace.
        </p>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <LabeledInput
            label="Text to protect"
            htmlFor="protected-registry-value"
            hint="Use the exact spelling users are likely to paste into chat."
          >
            <Input
              id="protected-registry-value"
              value={draft.value}
              placeholder="Northstar Biologics (Pty) Ltd"
              onChange={(event) => onDraftChange({ ...draft, value: event.target.value })}
            />
          </LabeledInput>
        </div>

        <LabeledInput label="Category" htmlFor="protected-registry-type">
          <Select
            id="protected-registry-type"
            value={draft.type}
            onChange={(value) => onDraftChange({ ...draft, type: value as ProtectedRegistryEntryType })}
          >
            {PROTECTED_REGISTRY_ENTRY_TYPES.map((type) => (
              <option key={type} value={type}>
                {TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
        </LabeledInput>

        <LabeledInput
          label="Matter or scope"
          htmlFor="protected-registry-matter-id"
          hint="Optional. Leave blank to protect this value everywhere."
        >
          <Input
            id="protected-registry-matter-id"
            value={draft.matterId}
            placeholder="NSB-2026-0147"
            onChange={(event) => onDraftChange({ ...draft, matterId: event.target.value })}
          />
        </LabeledInput>

        <div className="sm:col-span-2">
          <LabeledInput
            label="Also protect"
            htmlFor="protected-registry-aliases"
            hint="Optional. Separate nicknames, abbreviations, or alternate spellings with semicolons."
          >
            <Input
              id="protected-registry-aliases"
              value={draft.aliases}
              placeholder="Northstar; NBL"
              onChange={(event) => onDraftChange({ ...draft, aliases: event.target.value })}
            />
          </LabeledInput>
        </div>

        {editing ? (
          <LabeledInput
            label="Review status"
            htmlFor="protected-registry-status"
            hint="Only approved values are exported to the proxy."
          >
            <Select
              id="protected-registry-status"
              value={draft.status}
              onChange={(value) => onDraftChange({ ...draft, status: value as ProtectedRegistryEntryStatus })}
            >
              {PROTECTED_REGISTRY_ENTRY_STATUSES.map((entryStatus) => (
                <option key={entryStatus} value={entryStatus}>
                  {STATUS_LABELS[entryStatus]}
                </option>
              ))}
            </Select>
          </LabeledInput>
        ) : null}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button type="button" size="sm" onClick={onSubmit} disabled={!canSave}>
          {editing ? <Check className="size-4" aria-hidden /> : <Plus className="size-4" aria-hidden />}
          {editing ? "Save protected value" : "Protect value"}
        </Button>
        {editing ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Discard changes
          </Button>
        ) : null}
        {status === "error" ? <p className="text-destructive text-xs">Could not save this value.</p> : null}
      </div>
    </div>
  );
}

function ImportPanel({
  value,
  onChange,
  warnings,
  status,
  onImport,
}: {
  value: string;
  onChange: (value: string) => void;
  warnings: string[];
  status: SaveStatus;
  onImport: () => void;
}) {
  return (
    <div>
      <h4 className="text-sm font-medium">Import CSV</h4>
      <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
        Header row supported: <code className="font-mono">scope_id,type,value,aliases,status</code>.
      </p>
      <textarea
        value={value}
        rows={8}
        className="mt-3 min-h-36 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-5 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        placeholder={`scope_id,type,value,aliases,status\nPROJ-1049,project,Northstar Renewal,"Northstar; Renewal",approved`}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onImport}
          disabled={!value.trim() || status === "saving"}
        >
          <Upload className="size-4" aria-hidden />
          Import rows
        </Button>
        {status === "error" ? <p className="text-destructive text-xs">Import failed.</p> : null}
      </div>
      {warnings.length > 0 ? (
        <ul className="mt-3 list-disc space-y-1 pl-4 text-amber-700 text-xs leading-relaxed dark:text-amber-300">
          {warnings.slice(0, 5).map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
          {warnings.length > 5 ? <li>{warnings.length - 5} more warning(s).</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

function ProtectedRegistryTable({
  entries,
  onEdit,
  onDelete,
  onSetStatus,
}: {
  entries: ProtectedRegistryEntry[] | undefined;
  onEdit: (entry: ProtectedRegistryEntry) => void;
  onDelete: (entry: ProtectedRegistryEntry) => void;
  onSetStatus: (entry: ProtectedRegistryEntry, status: ProtectedRegistryEntryStatus) => void;
}) {
  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium">Registry entries</h4>
          <p className="pt-1 text-muted-foreground text-xs leading-relaxed">
            Protected values are visible to admins here. Proof views should show labels and counts only.
          </p>
        </div>
        <span className="text-muted-foreground text-xs">{entries ? `${entries.length} total` : "Loading..."}</span>
      </div>
      <div className="mt-3 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[52rem] text-left text-sm">
          <thead className="border-b border-border bg-muted/50 text-muted-foreground text-xs">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Value
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Scope
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Type
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Status
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {entries === undefined ? (
              <tr>
                <td className="px-3 py-4 text-muted-foreground" colSpan={5}>
                  Loading registry...
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-muted-foreground" colSpan={5}>
                  No registry entries yet.
                </td>
              </tr>
            ) : (
              entries.map((entry) => (
                <tr key={entry.id} className="border-b border-border last:border-b-0">
                  <td className="max-w-sm px-3 py-2 align-top">
                    <div className="font-medium text-foreground">{entry.value}</div>
                    {entry.aliases.length > 0 ? (
                      <div className="mt-1 break-words text-muted-foreground text-xs">
                        Aliases: {entry.aliases.join("; ")}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 align-top text-muted-foreground">{entry.matterId || "All scopes"}</td>
                  <td className="px-3 py-2 align-top">{TYPE_LABELS[entry.type]}</td>
                  <td className="px-3 py-2 align-top">
                    <StatusBadge status={entry.status} />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex items-center gap-1">
                      {entry.status !== "approved" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => onSetStatus(entry, "approved")}
                        >
                          <Check className="size-4" aria-hidden />
                          <span className="sr-only">Approve {entry.value}</span>
                        </Button>
                      ) : null}
                      <Button type="button" variant="ghost" size="icon-sm" onClick={() => onEdit(entry)}>
                        <Pencil className="size-4" aria-hidden />
                        <span className="sr-only">Edit {entry.value}</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => onDelete(entry)}
                      >
                        <Trash2 className="size-4" aria-hidden />
                        <span className="sr-only">Delete {entry.value}</span>
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ProtectedRegistryEntryStatus }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center rounded-full border px-2 text-xs font-medium",
        status === "approved" &&
          "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100",
        status === "suggested" &&
          "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100",
        status === "ignored" && "border-border bg-secondary text-secondary-foreground",
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function LabeledInput({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="block space-y-1.5">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      {children}
      {hint ? <span className="block text-muted-foreground text-xs leading-relaxed">{hint}</span> : null}
    </label>
  );
}

function Select({
  id,
  value,
  onChange,
  children,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      id={id}
      value={value}
      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
      onChange={(event) => onChange(event.target.value)}
    >
      {children}
    </select>
  );
}

function setDraftFromEntry(setDraft: (draft: Draft) => void) {
  return (entry: ProtectedRegistryEntry) =>
    setDraft({
      id: entry.id,
      matterId: entry.matterId,
      type: entry.type,
      value: entry.value,
      aliases: entry.aliases.join("; "),
      status: entry.status,
    });
}

function draftToInput(draft: Draft): ProtectedRegistryEntryInput {
  return {
    ...(draft.id ? { id: draft.id } : {}),
    matterId: draft.matterId,
    type: draft.type,
    value: draft.value,
    aliases: splitAliases(draft.aliases),
    status: draft.status,
    source: "manual",
  };
}

function entryToInput(entry: ProtectedRegistryEntry): ProtectedRegistryEntryInput {
  return {
    id: entry.id,
    matterId: entry.matterId,
    type: entry.type,
    value: entry.value,
    aliases: entry.aliases,
    status: entry.status,
    source: entry.source,
  };
}

function splitAliases(value: string): string[] {
  return value
    .split(/[;|]/)
    .map((alias) => alias.trim())
    .filter(Boolean);
}
