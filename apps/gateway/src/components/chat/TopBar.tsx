import {
  AlertTriangle,
  ChevronDown,
  Circle,
  CircleAlert,
  CircleDot,
  CircleOff,
  Eye,
  EyeOff,
  FileCheck2,
  ListChecks,
  ListTodo,
  Loader2,
  LockKeyhole,
  Moon,
  PanelLeft,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type ProtectionTone, protectionPresentation } from "@/lib/protection-copy";
import type { ProtectionStatus } from "@/lib/protection-status";
import type { RestoreHighlightDisplayMode } from "@/lib/restore-highlights";
import { useTheme } from "@/lib/use-theme";

export function TopBar({
  sidebarOpen,
  onToggleSidebar,
  protectionStatus,
  threadTraceEnabled = false,
  threadTraceControlVisible = false,
  threadTraceControlDisabled = true,
  threadTraceControlLoading = false,
  threadTraceError = false,
  traceAuditEnabled = false,
  onToggleThreadTrace,
  reviewBeforeSend = true,
  reviewBeforeSendRequired = false,
  onToggleReviewBeforeSend,
  restoreDisplayMode = "values",
  restoreHighlightsAvailable = false,
  onToggleRestoreDisplay,
  onOpenEvidence,
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
  traceAuditEnabled?: boolean;
  onToggleThreadTrace?: () => void;
  reviewBeforeSend?: boolean;
  reviewBeforeSendRequired?: boolean;
  onToggleReviewBeforeSend?: () => void;
  restoreDisplayMode?: RestoreHighlightDisplayMode;
  restoreHighlightsAvailable?: boolean;
  onToggleRestoreDisplay?: () => void;
  onOpenEvidence?: () => void;
}) {
  const { theme, toggle } = useTheme();
  const restoreToggle = restorePrivacyToggleLabels(restoreDisplayMode);
  const protection = protectionPresentation(protectionStatus);
  const ProtectionIcon = protection.tone === "good" ? ShieldCheck : AlertTriangle;
  const traceToggle = threadTraceToggleLabels({
    enabled: threadTraceEnabled,
    disabled: threadTraceControlDisabled,
    loading: threadTraceControlLoading,
    error: threadTraceError,
    valueAudit: traceAuditEnabled,
  });
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 items-center gap-2.5">
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={protectionTriggerClass(protection.tone)}
                aria-label={`${protection.label}. Open protection controls`}
              >
                <ProtectionIcon className={protectionIconClass(protection.tone)} aria-hidden />
                <span className="hidden max-w-36 truncate sm:inline">{protection.label}</span>
                <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={8} className="w-[min(21rem,calc(100vw-2rem))]">
              <DropdownMenuLabel className="px-2 py-2">
                <span className="block text-sm font-medium">Protection</span>
                <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">
                  {protection.description}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {onToggleReviewBeforeSend ? (
                reviewBeforeSendRequired ? (
                  <DropdownMenuLabel className="flex items-center gap-2 font-normal">
                    <LockKeyhole className="size-4 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1">Review before sending</span>
                    <span className="text-xs text-muted-foreground">Required</span>
                  </DropdownMenuLabel>
                ) : (
                  <DropdownMenuItem onSelect={onToggleReviewBeforeSend}>
                    {reviewBeforeSend ? (
                      <ListChecks className="size-4" aria-hidden />
                    ) : (
                      <ListTodo className="size-4" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1">Review before sending</span>
                    <span className="text-xs text-muted-foreground">{reviewBeforeSend ? "On" : "Off"}</span>
                  </DropdownMenuItem>
                )
              ) : null}
              {threadTraceError ? (
                <span className="sr-only" role="status" aria-live="polite">
                  Trace capture setting wasn't saved.
                </span>
              ) : null}
              {(restoreHighlightsAvailable && onToggleRestoreDisplay) || onOpenEvidence ? (
                <DropdownMenuSeparator />
              ) : null}
              {restoreHighlightsAvailable && onToggleRestoreDisplay ? (
                <DropdownMenuItem onSelect={onToggleRestoreDisplay}>
                  {restoreDisplayMode === "surrogates" ? (
                    <Eye className="size-4" aria-hidden />
                  ) : (
                    <EyeOff className="size-4" aria-hidden />
                  )}
                  {restoreToggle.menuLabel}
                </DropdownMenuItem>
              ) : null}
              {onOpenEvidence ? (
                <DropdownMenuItem onSelect={onOpenEvidence}>
                  <FileCheck2 className="size-4" aria-hidden />
                  View protection record
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          {threadTraceControlVisible && onToggleThreadTrace ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onToggleThreadTrace}
                  disabled={threadTraceControlLoading}
                  aria-label={traceToggle.ariaLabel}
                  className={traceTriggerClass({
                    enabled: threadTraceEnabled,
                    disabled: threadTraceControlDisabled,
                    error: threadTraceError,
                  })}
                >
                  {threadTraceControlLoading ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : threadTraceError ? (
                    <CircleAlert className="size-3.5" aria-hidden />
                  ) : threadTraceControlDisabled ? (
                    <CircleOff className="size-3.5" aria-hidden />
                  ) : threadTraceEnabled ? (
                    <CircleDot className="size-3.5" aria-hidden />
                  ) : (
                    <Circle className="size-3.5" aria-hidden />
                  )}
                  <span className="hidden max-w-40 truncate text-xs min-[360px]:inline">{traceToggle.label}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{traceToggle.tooltip}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <div className="flex items-center">
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
  valueAudit = false,
}: {
  enabled: boolean;
  disabled: boolean;
  loading?: boolean;
  error?: boolean;
  valueAudit?: boolean;
}): {
  ariaLabel: string;
  label: string;
  tooltip: string;
} {
  if (loading) {
    return {
      ariaLabel: "Checking trace capture availability",
      label: "Checking trace",
      tooltip: "Trace capture: Checking availability…",
    };
  }
  if (error) {
    return {
      ariaLabel: "Retry changing trace capture",
      label: "Trace error",
      tooltip: "Trace capture setting wasn't saved · Click to try again",
    };
  }
  if (disabled) {
    return {
      ariaLabel: "Trace disabled; open administrator settings",
      label: "Trace disabled",
      tooltip: "Runtime trace capture is disabled · Click to open admin settings",
    };
  }
  if (enabled) {
    return {
      ariaLabel: "Stop trace capture for this chat",
      label: valueAudit ? "Tracing bodies + values" : "Tracing bodies",
      tooltip: valueAudit
        ? "This chat is capturing raw bodies and protected values · Click to stop"
        : "This chat is capturing raw bodies · Click to stop",
    };
  }
  return {
    ariaLabel: "Start trace capture for this chat",
    label: "Trace ready",
    tooltip: "Runtime capture is available, but this chat is not opted in · Click to start",
  };
}

export function restorePrivacyToggleLabels(mode: RestoreHighlightDisplayMode): {
  ariaLabel: string;
  tooltip: string;
  menuLabel: string;
} {
  return mode === "surrogates"
    ? {
        ariaLabel: "Show original values",
        tooltip: "Show original values",
        menuLabel: "Show original values",
      }
    : {
        ariaLabel: "Show protected tokens",
        tooltip: "Show protected tokens",
        menuLabel: "Show protected tokens",
      };
}

function protectionTriggerClass(tone: ProtectionTone): string {
  if (tone === "warning")
    return "border-amber-300 bg-amber-50 text-amber-950 hover:bg-amber-100 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100 dark:hover:bg-amber-950/50";
  if (tone === "danger")
    return "border-red-300 bg-red-50 text-red-900 hover:bg-red-100 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100 dark:hover:bg-red-950/50";
  return "border-border bg-secondary text-secondary-foreground hover:bg-secondary/80";
}

function traceTriggerClass({
  enabled,
  disabled,
  error,
}: {
  enabled: boolean;
  disabled: boolean;
  error: boolean;
}): string {
  if (error) return "border-destructive/50 text-destructive hover:bg-destructive/10";
  if (enabled)
    return "border-amber-300 bg-amber-50 text-amber-950 hover:bg-amber-100 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100 dark:hover:bg-amber-950/50";
  if (disabled) return "border-border text-muted-foreground hover:bg-secondary";
  return "border-border bg-secondary text-secondary-foreground hover:bg-secondary/80";
}

function protectionIconClass(tone: ProtectionTone): string {
  if (tone === "good") return "size-4 text-emerald-600 dark:text-emerald-400";
  if (tone === "warning") return "size-4 text-amber-700 dark:text-amber-300";
  if (tone === "danger") return "size-4 text-red-700 dark:text-red-300";
  return "size-4 text-muted-foreground";
}
