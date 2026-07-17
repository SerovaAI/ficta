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
  Flag,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type ProtectionTone, protectionPresentation } from "@/lib/protection-copy";
import {
  effectiveProtectionReviewMode,
  isProtectionReviewMode,
  PROTECTION_REVIEW_MODES,
  type ProtectionReviewMode,
  protectionReviewModeAllowed,
  protectionReviewModeLabel,
} from "@/lib/protection-review-mode";
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
  reviewMode = "adaptive",
  reviewMinimum = "off",
  onReviewModeChange,
  restoreDisplayMode = "values",
  restoreHighlightsAvailable = false,
  onToggleRestoreDisplay,
  onOpenEvidence,
  onReportIssue,
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
  reviewMode?: ProtectionReviewMode;
  reviewMinimum?: ProtectionReviewMode;
  onReviewModeChange?: (mode: ProtectionReviewMode) => void;
  restoreDisplayMode?: RestoreHighlightDisplayMode;
  restoreHighlightsAvailable?: boolean;
  onToggleRestoreDisplay?: () => void;
  onOpenEvidence?: () => void;
  onReportIssue?: () => void;
}) {
  const { theme, toggle } = useTheme();
  const restoreToggle = restorePrivacyToggleLabels(restoreDisplayMode);
  const protection = protectionPresentation(protectionStatus);
  const effectiveReviewMode = effectiveProtectionReviewMode(reviewMode, reviewMinimum);
  const ProtectionIcon = protection.tone === "good" ? ShieldCheck : AlertTriangle;
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
              {onReviewModeChange ? (
                <>
                  <DropdownMenuLabel className="px-2 py-2 font-normal">
                    <span className="flex items-center justify-between gap-3">
                      <span className="font-medium">Review mode</span>
                      <span className="text-xs text-muted-foreground">
                        {protectionReviewModeLabel(effectiveReviewMode)}
                      </span>
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                      Adaptive checks every send and pauses only when protected values are found.
                    </span>
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={effectiveReviewMode}
                    onValueChange={(mode) => {
                      if (isProtectionReviewMode(mode) && protectionReviewModeAllowed(mode, reviewMinimum)) {
                        onReviewModeChange(mode);
                      }
                    }}
                  >
                    {PROTECTION_REVIEW_MODES.map((mode) => {
                      const allowed = protectionReviewModeAllowed(mode, reviewMinimum);
                      return (
                        <DropdownMenuRadioItem key={mode} value={mode} disabled={!allowed} className="items-start py-2">
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5 font-medium">
                              {protectionReviewModeLabel(mode)}
                              {!allowed ? <LockKeyhole className="size-3.5" aria-hidden /> : null}
                            </span>
                            <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                              {reviewModeDescription(mode, allowed)}
                            </span>
                          </span>
                        </DropdownMenuRadioItem>
                      );
                    })}
                  </DropdownMenuRadioGroup>
                </>
              ) : null}
              {onReviewModeChange && threadTraceControlVisible && onToggleThreadTrace ? (
                <DropdownMenuSeparator />
              ) : null}
              {threadTraceControlVisible && onToggleThreadTrace ? (
                <DropdownMenuItem onSelect={onToggleThreadTrace} disabled={threadTraceControlLoading}>
                  {threadTraceControlLoading ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : threadTraceError ? (
                    <CircleAlert className="size-4 text-destructive" aria-hidden />
                  ) : threadTraceControlDisabled ? (
                    <CircleOff className="size-4" aria-hidden />
                  ) : threadTraceEnabled ? (
                    <CircleDot className="size-4" aria-hidden />
                  ) : (
                    <Circle className="size-4" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1">Diagnostic trace</span>
                  <span className="text-xs text-muted-foreground">
                    {traceMenuStatus({
                      enabled: threadTraceEnabled,
                      disabled: threadTraceControlDisabled,
                      loading: threadTraceControlLoading,
                      error: threadTraceError,
                      valueAudit: traceAuditEnabled,
                    })}
                  </span>
                </DropdownMenuItem>
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
        </div>
        <div className="flex items-center">
          {onReportIssue ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={onReportIssue} aria-label="Report an issue">
                  <Flag className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Report an issue</TooltipContent>
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

function traceMenuStatus({
  enabled,
  disabled,
  loading,
  error,
  valueAudit,
}: {
  enabled: boolean;
  disabled: boolean;
  loading: boolean;
  error: boolean;
  valueAudit: boolean;
}): string {
  if (loading) return "Checking…";
  if (error) return "Retry";
  if (disabled) return "Set up";
  if (enabled) return valueAudit ? "Bodies + values" : "Bodies";
  return "Off";
}

function protectionIconClass(tone: ProtectionTone): string {
  if (tone === "good") return "size-4 text-emerald-600 dark:text-emerald-400";
  if (tone === "warning") return "size-4 text-amber-700 dark:text-amber-300";
  if (tone === "danger") return "size-4 text-red-700 dark:text-red-300";
  return "size-4 text-muted-foreground";
}

function reviewModeDescription(mode: ProtectionReviewMode, allowed: boolean): string {
  if (!allowed) return "Unavailable below the administrator minimum.";
  if (mode === "off") return "Send without checking for review findings.";
  if (mode === "adaptive") return "Review only when protected values are found.";
  return "Review every message before it is sent.";
}
