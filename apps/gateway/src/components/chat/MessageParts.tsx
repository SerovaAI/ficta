import type { UIMessage } from "@tanstack/ai-react";
import { ChevronRight } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import {
  protectionAnnotationsFromPart,
  type RestoreHighlightDisplayMode,
  stripRestoreHighlightMarkers,
} from "@/lib/restore-highlights";

const Markdown = lazy(() => import("./Markdown"));

type Part = UIMessage["parts"][number];

/** Renders the parts of one assistant/user turn. Text streams through markdown; reasoning collapses;
 * tool calls get a minimal chip (they aren't exercised yet, but the union includes them). */
export function MessageParts({
  parts,
  restoreDisplayMode,
}: {
  parts: Part[];
  restoreDisplayMode: RestoreHighlightDisplayMode;
}) {
  return (
    <>
      {parts.map((part, i) => {
        switch (part.type) {
          case "text":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: streamed parts are append-only, index is stable
              <Suspense key={i} fallback={<MarkdownFallback content={part.content} />}>
                <Markdown
                  content={part.content}
                  annotations={protectionAnnotationsFromPart(part, "restored")}
                  restoreDisplayMode={restoreDisplayMode}
                />
              </Suspense>
            );
          case "thinking":
            // biome-ignore lint/suspicious/noArrayIndexKey: streamed parts are append-only, index is stable
            return <Reasoning key={i} content={part.content} />;
          case "tool-call":
            return (
              <div
                key={part.id}
                className="my-1 inline-flex items-center gap-2 rounded-md border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground"
              >
                <span className="font-mono">{part.name}</span>
                <span className="opacity-70">{part.state}</span>
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

function MarkdownFallback({ content }: { content: string }) {
  return (
    <div className="whitespace-pre-wrap text-[0.95rem] leading-relaxed">{stripRestoreHighlightMarkers(content)}</div>
  );
}

function Reasoning({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
        Reasoning
      </button>
      {open ? (
        <div className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-3 text-muted-foreground">
          {stripRestoreHighlightMarkers(content)}
        </div>
      ) : null}
    </div>
  );
}
