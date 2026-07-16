import { SUPPORTED_DETECTION_JURISDICTIONS } from "@serovaai/ficta-protocol";
import { AlertTriangle, PanelRightClose, ShieldCheck, X } from "lucide-react";
import { type RefObject, useId } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { detectionJurisdictionSummary, jurisdictionLabel } from "@/lib/detection-jurisdictions";
import { cn } from "@/lib/utils";

export function JurisdictionSidebar({
  desktopOpen,
  drawerOpen,
  onCloseDesktop,
  onDrawerOpenChange,
  jurisdictions,
  onToggleJurisdiction,
  saveError,
  onDismissSaveError,
  desktopTriggerRef,
  drawerTriggerRef,
}: {
  desktopOpen: boolean;
  drawerOpen: boolean;
  onCloseDesktop: () => void;
  onDrawerOpenChange: (open: boolean) => void;
  jurisdictions: string[];
  onToggleJurisdiction: (code: string) => void;
  saveError: boolean;
  onDismissSaveError: () => void;
  desktopTriggerRef: RefObject<HTMLButtonElement | null>;
  drawerTriggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const summary = detectionJurisdictionSummary(jurisdictions);
  const contentProps = {
    jurisdictions,
    onToggleJurisdiction,
    saveError,
    onDismissSaveError,
  };

  return (
    <>
      {desktopOpen ? (
        <aside
          id="jurisdiction-sidebar"
          aria-label="Jurisdiction detection"
          className="hidden h-dvh w-[280px] shrink-0 flex-col border-l border-border bg-secondary xl:flex"
        >
          <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">Jurisdiction detection</h2>
              <p className="truncate text-xs text-muted-foreground">{summary}</p>
            </div>
            <Button variant="ghost" size="icon" onClick={onCloseDesktop} aria-label="Close jurisdiction detection">
              <PanelRightClose className="size-4" aria-hidden />
            </Button>
          </div>
          <JurisdictionPanelContent {...contentProps} />
        </aside>
      ) : null}

      <Dialog open={drawerOpen} onOpenChange={onDrawerOpenChange}>
        <DialogContent
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const drawerTrigger = drawerTriggerRef.current;
            const trigger = drawerTrigger?.getClientRects().length ? drawerTrigger : desktopTriggerRef.current;
            trigger?.focus();
          }}
          className="top-0 right-0 bottom-0 left-auto flex h-dvh w-[min(320px,calc(100vw-2rem))] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-r-0 bg-secondary p-0 shadow-xl transition-transform duration-200 data-[state=closed]:translate-x-full data-[state=open]:translate-x-0 xl:hidden"
        >
          <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
            <DialogHeader className="min-w-0 gap-0">
              <DialogTitle className="truncate text-sm leading-5">Jurisdiction detection</DialogTitle>
              <DialogDescription className="truncate text-xs leading-4">{summary}</DialogDescription>
            </DialogHeader>
            <DialogClose asChild>
              <Button variant="ghost" size="icon" aria-label="Close jurisdiction detection">
                <PanelRightClose className="size-4" aria-hidden />
              </Button>
            </DialogClose>
          </div>
          <JurisdictionPanelContent {...contentProps} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function JurisdictionPanelContent({
  jurisdictions,
  onToggleJurisdiction,
  saveError,
  onDismissSaveError,
}: {
  jurisdictions: string[];
  onToggleJurisdiction: (code: string) => void;
  saveError: boolean;
  onDismissSaveError: () => void;
}) {
  const id = useId();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="p-4">
        <p className="text-sm leading-5 text-muted-foreground">
          Add country-specific best-effort detectors to this chat.
        </p>

        {saveError ? (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p className="min-w-0 flex-1">
              Couldn&apos;t save this detection profile. The previous profile remains active.
            </p>
            <button
              type="button"
              onClick={onDismissSaveError}
              aria-label="Dismiss detection profile save error"
              className="rounded-md p-0.5 text-amber-900/70 hover:bg-amber-100 hover:text-amber-950 focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:p-2 dark:text-amber-100/70 dark:hover:bg-amber-900/40 dark:hover:text-amber-50"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        ) : null}

        <div className="mt-4 flex items-start gap-3 border-y border-border py-4">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium">Baseline detection</p>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">Always on</p>
          </div>
        </div>

        <fieldset className="mt-5">
          <legend className="text-sm font-medium">Additional jurisdictions</legend>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Select every jurisdiction that applies.</p>
          <div className="mt-3 overflow-hidden rounded-lg border border-border bg-background">
            {SUPPORTED_DETECTION_JURISDICTIONS.map((code, index) => {
              const checked = jurisdictions.includes(code);
              const inputId = `${id}-${code}`;
              return (
                <label
                  key={code}
                  htmlFor={inputId}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent",
                    index < SUPPORTED_DETECTION_JURISDICTIONS.length - 1 && "border-b border-border",
                  )}
                >
                  <Checkbox
                    id={inputId}
                    checked={checked}
                    onCheckedChange={() => onToggleJurisdiction(code)}
                    aria-label={`${checked ? "Remove" : "Add"} ${jurisdictionLabel(code)} detection`}
                  />
                  <span className="min-w-0 flex-1 text-sm font-medium">{jurisdictionLabel(code)}</span>
                  <span className="text-xs text-muted-foreground">{code.toUpperCase()}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </div>

      <div className="mt-auto border-t border-border p-4 text-xs leading-5 text-muted-foreground">
        <p>Selections widen best-effort detection; they never reduce baseline or registered-value protection.</p>
        <p className="mt-2">Changes apply immediately and save with this chat.</p>
      </div>
    </div>
  );
}
