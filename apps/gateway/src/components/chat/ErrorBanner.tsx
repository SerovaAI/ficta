import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    // Same measure as the composer + protection notice: max-w-3xl column, box inset by px-4.
    <div className="mx-auto w-full max-w-3xl px-4">
      <div
        role="alert"
        className="flex w-full items-start gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="flex-1">{message}</span>
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}
