import { KeyRound, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PROVIDERS, type Provider } from "@/lib/models";
import { deleteProviderKey, fetchProviderKeySummaries, saveProviderKey } from "@/lib/storage/providerKeys";
import type { ProviderKeySummary } from "@/lib/storage/types";
import { SettingRow } from "./SettingRow";

type SaveStatus = "idle" | "saving" | "error";

const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

export function ProviderKeysSection() {
  const [summaries, setSummaries] = useState<ProviderKeySummary[]>();
  const [drafts, setDrafts] = useState<Record<Provider, string>>({ openai: "", anthropic: "" });
  const [statuses, setStatuses] = useState<Record<Provider, SaveStatus>>({ openai: "idle", anthropic: "idle" });
  const [errors, setErrors] = useState<Record<Provider, string>>({ openai: "", anthropic: "" });
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let alive = true;
    fetchProviderKeySummaries()
      .then((next) => {
        if (!alive) return;
        setSummaries(next);
        setLoadError("");
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setLoadError(err instanceof Error ? err.message : "Could not load provider keys.");
      });
    return () => {
      alive = false;
    };
  }, []);

  const setDraft = (provider: Provider, value: string) => {
    setDrafts((current) => ({ ...current, [provider]: value }));
    setStatuses((current) => ({ ...current, [provider]: "idle" }));
  };

  const save = async (provider: Provider) => {
    const apiKey = drafts[provider].trim();
    if (!apiKey) {
      setErrors((current) => ({ ...current, [provider]: "Enter a key before saving." }));
      setStatuses((current) => ({ ...current, [provider]: "error" }));
      return;
    }
    setStatuses((current) => ({ ...current, [provider]: "saving" }));
    setErrors((current) => ({ ...current, [provider]: "" }));
    try {
      const next = await saveProviderKey({ data: { provider, apiKey } });
      setSummaries(next);
      setDrafts((current) => ({ ...current, [provider]: "" }));
      setStatuses((current) => ({ ...current, [provider]: "idle" }));
    } catch (err) {
      setErrors((current) => ({
        ...current,
        [provider]: err instanceof Error ? err.message : "Could not save provider key.",
      }));
      setStatuses((current) => ({ ...current, [provider]: "error" }));
    }
  };

  const remove = async (provider: Provider) => {
    setStatuses((current) => ({ ...current, [provider]: "saving" }));
    setErrors((current) => ({ ...current, [provider]: "" }));
    try {
      const next = await deleteProviderKey({ data: { provider } });
      setSummaries(next);
      setDrafts((current) => ({ ...current, [provider]: "" }));
      setStatuses((current) => ({ ...current, [provider]: "idle" }));
    } catch (err) {
      setErrors((current) => ({
        ...current,
        [provider]: err instanceof Error ? err.message : "Could not delete provider key.",
      }));
      setStatuses((current) => ({ ...current, [provider]: "error" }));
    }
  };

  return (
    <section aria-label="Provider keys">
      <div className="pt-6 pb-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Provider keys</h3>
        <p className="pt-1 text-xs text-muted-foreground leading-relaxed">
          Workspace keys are encrypted before they are stored. Existing keys cannot be revealed.
        </p>
      </div>

      {loadError ? <p className="py-4 text-sm text-muted-foreground">{loadError}</p> : null}
      {!summaries && !loadError ? <p className="py-4 text-sm text-muted-foreground">Loading provider keys...</p> : null}
      {summaries
        ? PROVIDERS.map((provider) => {
            const summary = summaries.find((item) => item.provider === provider);
            return (
              <SettingRow
                key={provider}
                label={PROVIDER_LABELS[provider]}
                htmlFor={`provider-key-${provider}`}
                description={summary?.configured ? `Saved key ${summary.keyHint}` : "No workspace key saved."}
              >
                <div className="w-full max-w-md space-y-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Input
                      id={`provider-key-${provider}`}
                      type="password"
                      autoComplete="off"
                      value={drafts[provider]}
                      placeholder={summary?.configured ? "Replace key" : "Paste API key"}
                      className="min-w-0 font-mono text-xs"
                      onChange={(event) => setDraft(provider, event.target.value)}
                    />
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      disabled={statuses[provider] === "saving"}
                      onClick={() => void save(provider)}
                    >
                      <KeyRound className="size-4" aria-hidden />
                      <span className="sr-only">Save {PROVIDER_LABELS[provider]} key</span>
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      disabled={!summary?.configured || statuses[provider] === "saving"}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => void remove(provider)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                      <span className="sr-only">Delete {PROVIDER_LABELS[provider]} key</span>
                    </Button>
                  </div>
                  <ProviderKeyStatus status={statuses[provider]} error={errors[provider]} />
                </div>
              </SettingRow>
            );
          })
        : null}
    </section>
  );
}

function ProviderKeyStatus({ status, error }: { status: SaveStatus; error: string }) {
  if (status === "idle") return null;
  return (
    <p className={status === "error" ? "text-destructive text-xs" : "text-muted-foreground text-xs"}>
      {status === "saving" ? "Saving..." : error}
    </p>
  );
}
