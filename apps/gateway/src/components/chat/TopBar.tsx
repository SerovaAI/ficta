import { Eye, EyeOff, Moon, PanelLeft, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProtectionStatus } from "@/lib/protection-status";
import type { RestoreHighlightDisplayMode } from "@/lib/restore-highlights";
import { useTheme } from "@/lib/use-theme";
import { ProtectionBadge } from "./ProtectionBadge";

export function TopBar({
  sidebarOpen,
  onToggleSidebar,
  protectionStatus,
  restoreDisplayMode = "values",
  restoreHighlightsAvailable = false,
  onToggleRestoreDisplay,
}: {
  /** Sidebar state + toggle. Optional so TopBar still renders without the history sidebar. */
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  protectionStatus?: ProtectionStatus;
  restoreDisplayMode?: RestoreHighlightDisplayMode;
  restoreHighlightsAvailable?: boolean;
  onToggleRestoreDisplay?: () => void;
}) {
  const { theme, toggle } = useTheme();
  const restoreToggle = restorePrivacyToggleLabels(restoreDisplayMode);
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4">
        <div className="flex items-center gap-2.5">
          {onToggleSidebar ? (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Mobile only: on desktop the sidebar is always visible (full or 52px rail) and carries its
                    own expand/collapse control, so this would be redundant there. */}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onToggleSidebar}
                  aria-label="Toggle chat history"
                  className="md:hidden"
                >
                  <PanelLeft className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{sidebarOpen ? "Hide history" : "Show history"}</TooltipContent>
            </Tooltip>
          ) : null}
          {/* Brand now lives in the sidebar header; the top bar carries only the protection status. It
              stays visible on every viewport — an always-on trust cue — collapsing to icon-only on phones. */}
          <ProtectionBadge status={protectionStatus} labelClassName="hidden sm:inline" />
        </div>
        <div className="flex items-center gap-2">
          {restoreHighlightsAvailable && onToggleRestoreDisplay ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={restoreDisplayMode === "surrogates" ? "secondary" : "ghost"}
                  size="icon"
                  onClick={onToggleRestoreDisplay}
                  aria-label={restoreToggle.ariaLabel}
                  aria-pressed={restoreDisplayMode === "surrogates"}
                >
                  {restoreDisplayMode === "surrogates" ? (
                    <EyeOff className="size-4" aria-hidden />
                  ) : (
                    <Eye className="size-4" aria-hidden />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{restoreToggle.tooltip}</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
                {theme === "dark" ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{theme === "dark" ? "Light mode" : "Dark mode"}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </header>
  );
}

export function restorePrivacyToggleLabels(mode: RestoreHighlightDisplayMode): {
  ariaLabel: string;
  tooltip: string;
} {
  return mode === "surrogates"
    ? { ariaLabel: "Show restored values", tooltip: "Show restored values" }
    : { ariaLabel: "Show surrogates", tooltip: "Show surrogates" };
}
