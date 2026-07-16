import { X } from "lucide-react";
import type * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { isAdmin } from "@/lib/auth/types";
import { useAuthState } from "@/lib/auth/useAuthState";
import { useInstanceSettings } from "@/lib/storage/useInstanceSettings";
import { cn } from "@/lib/utils";
import { AdminSettingsForm } from "./AdminSettingsForm";
import { ProtectedRegistrySection } from "./ProtectedRegistrySection";
import { ProviderKeysSection } from "./ProviderKeysSection";
import { ProxyConfigSection } from "./ProxyConfigSection";
import { RedactionProofSection } from "./RedactionProofSection";
import { RetentionSettingsSection } from "./RetentionSettingsSection";

type AdminSection = "general" | "retention" | "keys" | "registry" | "proxy" | "proof";
export type AdminSettingsTarget = "runtime-trace-capture";

const SECTION_LABELS: Record<AdminSection, string> = {
  general: "General",
  retention: "Retention",
  keys: "Provider keys",
  registry: "Protected Registry",
  proxy: "Proxy configuration",
  proof: "Redaction proof",
};

/** Admin-only workspace settings. Server functions still enforce access; this guard is for navigation UX. */
export function AdminSettingsDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target?: AdminSettingsTarget;
}) {
  const auth = useAuthState();
  const instanceSettings = useInstanceSettings();
  const admin = isAdmin(auth);
  const [section, setSection] = useState<AdminSection>("general");
  const [pendingFocusTarget, setPendingFocusTarget] = useState<AdminSettingsTarget>();

  useEffect(() => {
    if (!open) {
      setPendingFocusTarget(undefined);
      return;
    }
    if (target === "runtime-trace-capture") {
      setSection("proxy");
      setPendingFocusTarget(target);
    }
  }, [open, target]);

  const clearPendingFocusTarget = useCallback(() => setPendingFocusTarget(undefined), []);

  if (!admin) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="grid h-[min(760px,calc(100dvh-2rem))] max-w-[1180px] grid-cols-[220px_minmax(0,1fr)] gap-0 overflow-hidden p-0 max-sm:h-[calc(100dvh-2rem)] max-sm:grid-cols-1"
      >
        <aside className="flex min-h-0 flex-col border-r border-border bg-muted/30 p-3 max-sm:border-r-0 max-sm:border-b">
          <DialogClose className="mb-3 flex size-9 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:size-11">
            <X className="size-5" aria-hidden />
            <span className="sr-only">Close admin settings</span>
          </DialogClose>
          <nav className="space-y-1" aria-label="Admin sections">
            {(["general", "retention", "keys", "registry", "proxy", "proof"] as const).map((key) => (
              <AdminSectionButton key={key} active={section === key} onClick={() => setSection(key)}>
                {SECTION_LABELS[key]}
              </AdminSectionButton>
            ))}
          </nav>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col">
          <header className="shrink-0 border-b border-border px-6 py-4">
            <DialogTitle className="text-xl">Admin</DialogTitle>
            <DialogDescription className="sr-only">
              Manage workspace settings, provider keys, proxy configuration, and redaction proof.
            </DialogDescription>
          </header>

          <div className="min-h-0 overflow-y-auto px-6 py-1">
            {section === "general" ? <AdminSettingsForm settings={instanceSettings} /> : null}
            {section === "retention" ? <RetentionSettingsSection settings={instanceSettings} /> : null}
            {section === "keys" ? <ProviderKeysSection /> : null}
            {section === "registry" ? <ProtectedRegistrySection /> : null}
            {section === "proxy" ? (
              <ProxyConfigSection
                focusRuntimeTraceCapture={pendingFocusTarget === "runtime-trace-capture"}
                onRuntimeTraceCaptureFocused={clearPendingFocusTarget}
              />
            ) : null}
            {section === "proof" ? <RedactionProofSection /> : null}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

function AdminSectionButton({ active, className, ...props }: React.ComponentProps<"button"> & { active: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-9 w-full items-center rounded-lg px-3 text-left text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11",
        active && "bg-accent text-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}
