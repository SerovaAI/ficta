import { FileDown, FileText, Loader2 } from "lucide-react";
import { type ReactNode, useContext } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type DocxDownload, DocxDownloadContext } from "@/lib/documents/use-docx-download";

/**
 * A `ficta:document` fence rendered as a document instead of a code block. While the fence streams,
 * the header is a progress line (title + the heading the model is currently drafting); once closed
 * it offers Download as Word, pre-rendered by the bubble's download hook so the click saves
 * instantly. The children are the fence's markdown, typeset like the rest of the chat.
 */
export function DocumentCard({
  title,
  closed,
  progress,
  children,
}: {
  title?: string;
  closed: boolean;
  /** Last heading the model emitted — shown as the drafting position while streaming. */
  progress?: string;
  children: ReactNode;
}) {
  const docx = useContext(DocxDownloadContext);

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-2">
        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate text-sm font-medium">{title || "Document"}</span>
        <span className="ml-auto flex min-w-0 items-center gap-2">
          {closed ? (
            docx ? (
              <DownloadButton docx={docx} />
            ) : null
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
              <span className="truncate">{progress ? `Drafting — ${progress}` : "Drafting…"}</span>
            </span>
          )}
        </span>
      </div>
      <div className="px-4 py-3">{children}</div>
      {closed ? (
        <div className="border-t border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          Formatting is regenerated on download — review numbering and cross-references.
        </div>
      ) : null}
    </div>
  );
}

function DownloadButton({ docx }: { docx: DocxDownload }) {
  const rendering = docx.status === "rendering";
  const blocked = docx.status === "blocked";
  const label = docx.message ?? "Download as Word";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* aria-disabled instead of disabled so the blocked explanation stays reachable by hover
            and focus (a disabled button receives neither); the click is a no-op while blocked. */}
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs aria-disabled:opacity-50"
          onClick={blocked ? undefined : docx.download}
          aria-disabled={blocked || rendering}
          aria-label={label}
        >
          {rendering ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <FileDown className="size-3.5" aria-hidden />
          )}
          Word
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
