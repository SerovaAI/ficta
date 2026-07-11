import {
  Circle,
  CircleAlert,
  CircleDot,
  CircleOff,
  Eye,
  EyeOff,
  ListChecks,
  ListTodo,
  Loader2,
  LockKeyhole,
  Moon,
  PanelLeft,
  Sun,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProtectionStatus } from "@/lib/protection-status";
import type { RestoreHighlightDisplayMode } from "@/lib/restore-highlights";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/utils";
import { ProtectionBadge } from "./ProtectionBadge";

export function TopBar({
  sidebarOpen,
  onToggleSidebar,
  protectionStatus,
  threadTraceEnabled = false,
  threadTraceControlVisible = false,
  threadTraceControlDisabled = true,
  threadTraceControlLoading = false,
  threadTraceError = false,
  onToggleThreadTrace,
  reviewBeforeSend = true,
  reviewBeforeSendRequired = false,
  onToggleReviewBeforeSend,
  restoreDisplayMode = "values",
  restoreHighlightsAvailable = false,
  onToggleRestoreDisplay,
}: {
  /** Sidebar state + toggle. Optional so TopBar still renders without the history sidebar. */
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  protectionStatus?: ProtectionStatus;
  threadTraceEnabled?: boolean;
  threadTraceControlVisible?: boolean;
  threadTraceControlDisabled?: boolean;
  threadTraceControlLoading?: boolean;
  threadTraceError?: boolean;
  onToggleThreadTrace?: () => void;
  reviewBeforeSend?: boolean;
  reviewBeforeSendRequired?: boolean;
  onToggleReviewBeforeSend?: () => void;
  restoreDisplayMode?: RestoreHighlightDisplayMode;
  restoreHighlightsAvailable?: boolean;
  onToggleRestoreDisplay?: () => void;
}) {
  const { theme, toggle } = useTheme();
  const restoreToggle = restorePrivacyToggleLabels(restoreDisplayMode);
  const traceToggle = threadTraceToggleLabels({
    enabled: threadTraceEnabled,
    disabled: threadTraceControlDisabled,
    loading: threadTraceControlLoading,
    error: threadTraceError,
  });
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
          {onToggleReviewBeforeSend ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={reviewBeforeSend ? "secondary" : "ghost"}
                  size="icon"
                  className={cn(
                    reviewBeforeSend ? "text-foreground shadow-xs" : "text-muted-foreground",
                    reviewBeforeSendRequired && "cursor-default",
                  )}
                  onClick={onToggleReviewBeforeSend}
                  aria-disabled={reviewBeforeSendRequired}
                  aria-label={
                    reviewBeforeSendRequired
                      ? "Review before sending is required by your workspace"
                      : `${reviewBeforeSend ? "Disable" : "Enable"} review before sending for this chat`
                  }
                  aria-pressed={reviewBeforeSend}
                >
                  {reviewBeforeSendRequired ? (
                    <LockKeyhole className="size-4" aria-hidden />
                  ) : reviewBeforeSend ? (
                    <ListChecks className="size-4" aria-hidden />
                  ) : (
                    <ListTodo className="size-4" aria-hidden />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {reviewBeforeSendRequired
                  ? "Review before send is required by your workspace"
                  : reviewBeforeSend
                    ? "Review before send is on · Click to turn off"
                    : "Review before send is off · Click to turn on"}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {threadTraceControlVisible && onToggleThreadTrace ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={threadTraceEnabled ? "secondary" : "ghost"}
                  size="icon"
                  className={cn(
                    threadTraceEnabled ? "text-foreground shadow-xs" : "text-muted-foreground",
                    threadTraceError && "text-destructive",
                    (threadTraceControlDisabled || threadTraceControlLoading) && "cursor-default opacity-70",
                  )}
                  onClick={onToggleThreadTrace}
                  aria-disabled={threadTraceControlDisabled || threadTraceControlLoading}
                  aria-label={traceToggle.ariaLabel}
                  aria-pressed={threadTraceEnabled}
                >
                  {threadTraceControlLoading ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : threadTraceError ? (
                    <CircleAlert className="size-4" aria-hidden />
                  ) : threadTraceControlDisabled ? (
                    <CircleOff className="size-4" aria-hidden />
                  ) : threadTraceEnabled ? (
                    <CircleDot className="size-4" aria-hidden />
                  ) : (
                    <Circle className="size-4" aria-hidden />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{traceToggle.tooltip}</TooltipContent>
              {threadTraceError ? (
                <span className="sr-only" role="status" aria-live="polite">
                  Trace capture setting wasn't saved.
                </span>
              ) : null}
            </Tooltip>
          ) : null}
          {onToggleReviewBeforeSend || (threadTraceControlVisible && onToggleThreadTrace) ? (
            <span className="h-4 w-px bg-border" aria-hidden />
          ) : null}
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

export function threadTraceToggleLabels({
  enabled,
  disabled,
  loading = false,
  error = false,
}: {
  enabled: boolean;
  disabled: boolean;
  loading?: boolean;
  error?: boolean;
}): {
  ariaLabel: string;
  tooltip: string;
} {
  if (loading) {
    return {
      ariaLabel: "Checking trace capture availability",
      tooltip: "Trace capture: Checking availability…",
    };
  }
  if (error) {
    return {
      ariaLabel: "Retry changing trace capture",
      tooltip: "Trace capture setting wasn't saved · Click to try again",
    };
  }
  if (disabled) {
    return {
      ariaLabel: "Trace capture unavailable",
      tooltip: "Trace capture: Disabled by your server administrator · Click to open admin settings",
    };
  }
  if (enabled) {
    return {
      ariaLabel: "Stop trace capture for this chat",
      tooltip: "Trace capture: On for this chat · Click to stop",
    };
  }
  return {
    ariaLabel: "Start trace capture for this chat",
    tooltip: "Trace capture: Off for this chat · Click to start",
  };
}

export function restorePrivacyToggleLabels(mode: RestoreHighlightDisplayMode): {
  ariaLabel: string;
  tooltip: string;
} {
  return mode === "surrogates"
    ? { ariaLabel: "Show restored values", tooltip: "Show restored values" }
    : { ariaLabel: "Show surrogates", tooltip: "Show surrogates" };
}
