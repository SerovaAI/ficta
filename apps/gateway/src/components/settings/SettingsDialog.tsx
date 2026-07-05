import { X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { UserSettings } from "@/lib/storage/types";
import { UserSettingsForm } from "./UserSettingsForm";

/** Chat-style settings modal. Settings are an overlay on the current conversation, not a route/page. */
export function SettingsDialog({
  open,
  onOpenChange,
  userSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userSettings?: UserSettings;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="max-w-[560px] overflow-hidden p-0">
        <section className="flex min-h-0 min-w-0 flex-col">
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-4">
            <div className="min-w-0">
              <DialogTitle className="text-xl">Settings</DialogTitle>
              <DialogDescription className="sr-only">Manage your chat preferences.</DialogDescription>
            </div>
            <DialogClose className="flex size-9 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:size-11">
              <X className="size-5" aria-hidden />
              <span className="sr-only">Close settings</span>
            </DialogClose>
          </header>

          <div className="px-6 py-1">
            <UserSettingsForm settings={userSettings ?? {}} />
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
