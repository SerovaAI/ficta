import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { ArchiveRestore, ArrowLeft, CalendarClock, RotateCcw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { MessageParts } from "@/components/chat/MessageParts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchAuthState } from "@/lib/auth/auth";
import { hasRecordsPermission, RECORDS_PERMISSIONS } from "@/lib/auth/types";
import { useAuthState } from "@/lib/auth/useAuthState";
import { storedToUi } from "@/lib/storage/messages";
import { fetchRetainedThread, fetchRetainedThreads, restoreRetainedThread } from "@/lib/storage/records";
import { restoreConfirmationMessage } from "@/lib/storage/records-validation";
import type { RecordsAccessReason, RetainedThreadDetail, RetainedThreadSummary } from "@/lib/storage/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/records")({
  beforeLoad: async () => {
    const auth = await fetchAuthState();
    if (!hasRecordsPermission(auth, RECORDS_PERMISSIONS.list)) throw redirect({ to: "/" });
  },
  loader: () => fetchRetainedThreads(),
  component: RecordsPage,
});

function RecordsPage() {
  const retained = Route.useLoaderData();
  const auth = useAuthState();
  const router = useRouter();
  const canRead = hasRecordsPermission(auth, RECORDS_PERMISSIONS.read);
  const canRestore = hasRecordsPermission(auth, RECORDS_PERMISSIONS.restore);
  const [selectedId, setSelectedId] = useState(retained[0]?.threadId ?? "");
  const [reference, setReference] = useState("");
  const [detail, setDetail] = useState<RetainedThreadDetail>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reason = (): RecordsAccessReason => (reference.trim() ? { reference: reference.trim() } : {});

  const openSelected = async () => {
    if (!selectedId || !canRead) return;
    setBusy(true);
    setError("");
    try {
      const loaded = await fetchRetainedThread({ data: { threadId: selectedId, reason: reason() } });
      if (!loaded) throw new Error("This retained chat is no longer available.");
      setDetail(loaded);
    } catch (cause) {
      setDetail(undefined);
      setError(cause instanceof Error ? cause.message : "Could not open the retained chat.");
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!detail || !canRestore) return;
    if (!window.confirm(restoreConfirmationMessage(detail.ownerUserId))) return;
    setBusy(true);
    setError("");
    try {
      await restoreRetainedThread({ data: { threadId: detail.thread.id, reason: reason() } });
      setDetail(undefined);
      setSelectedId("");
      await router.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore the chat.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
          <Button asChild variant="ghost" size="icon" aria-label="Back to chat">
            <Link to="/">
              <ArrowLeft className="size-4" aria-hidden />
            </Link>
          </Button>
          <ArchiveRestore className="size-5 text-muted-foreground" aria-hidden />
          <div>
            <h1 className="font-semibold leading-tight">Records</h1>
            <p className="text-muted-foreground text-xs">Restricted deleted-chat recovery</p>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <div className="mb-5 flex max-w-3xl gap-3 rounded-xl border border-border bg-card p-4">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="text-sm">
            <p className="font-medium">Every transcript view and restore is recorded.</p>
            <p className="mt-1 text-muted-foreground">
              This is a recovery window, not a legal-hold system. Titles and message contents stay hidden until you open
              a transcript.
            </p>
          </div>
        </div>

        {retained.length === 0 ? (
          <section className="max-w-2xl rounded-xl border border-border bg-card px-6 py-12 text-center">
            <ArchiveRestore className="mx-auto size-7 text-muted-foreground" aria-hidden />
            <h2 className="mt-3 font-semibold">No retained chats</h2>
            <p className="mt-1 text-muted-foreground text-sm">
              Chats will appear here only when deleted-chat recovery is enabled and a user removes one.
            </p>
          </section>
        ) : (
          <div className="grid min-h-[560px] gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
            <section className="min-w-0 rounded-xl border border-border bg-card">
              <header className="border-b border-border px-4 py-3">
                <h2 className="font-semibold text-sm">Retained chats</h2>
                <p className="mt-0.5 text-muted-foreground text-xs">Metadata only · {retained.length} total</p>
              </header>
              <div className="max-h-72 overflow-y-auto p-2 lg:max-h-[500px]">
                {retained.map((thread) => (
                  <RetainedRow
                    key={thread.threadId}
                    thread={thread}
                    selected={selectedId === thread.threadId}
                    onSelect={() => {
                      setSelectedId(thread.threadId);
                      setDetail(undefined);
                      setError("");
                    }}
                  />
                ))}
              </div>
            </section>

            <section className="min-w-0 rounded-xl border border-border bg-card">
              <header className="border-b border-border px-5 py-4">
                <h2 className="font-semibold">Access retained content</h2>
                <p className="mt-1 text-muted-foreground text-sm">
                  Use a ticket identifier, never client details. Every open is recorded.
                </p>
                <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
                  <label htmlFor="records-ticket-reference" className="grid min-w-0 flex-1 gap-1 text-sm">
                    <span className="font-medium">Ticket reference (optional)</span>
                    <Input
                      id="records-ticket-reference"
                      value={reference}
                      onChange={(event) => setReference(event.target.value)}
                      placeholder="REC-1042"
                      autoComplete="off"
                    />
                  </label>
                  <Button disabled={!selectedId || !canRead || busy} onClick={() => void openSelected()}>
                    {busy && !detail ? "Opening…" : "Open transcript"}
                  </Button>
                </div>
                {!canRead ? (
                  <p className="mt-3 text-destructive text-sm">Your records access is metadata-only.</p>
                ) : null}
                {error ? (
                  <p className="mt-3 text-destructive text-sm" role="alert">
                    {error}
                  </p>
                ) : null}
              </header>

              {detail ? (
                <div>
                  <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold">{detail.thread.title}</h3>
                      <p className="mt-1 text-muted-foreground text-xs">
                        Owner {detail.ownerUserId} · purge scheduled {formatDateTime(detail.purgeAfter)}
                      </p>
                    </div>
                    <Button variant="outline" disabled={!canRestore || busy} onClick={() => void restore()}>
                      <RotateCcw className="size-4" aria-hidden />
                      {busy ? "Restoring…" : "Restore to owner"}
                    </Button>
                  </div>
                  <div className="max-h-[520px] space-y-6 overflow-y-auto px-5 py-5">
                    {detail.messages.map((message) => (
                      <article key={message.id} className="min-w-0">
                        <p className="mb-2 font-medium text-muted-foreground text-xs">
                          {message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : "System"}
                        </p>
                        <div
                          className={cn(
                            "text-[0.95rem]",
                            message.role === "user" && "rounded-xl bg-secondary px-4 py-3",
                          )}
                        >
                          <MessageParts parts={storedToUi(message).parts} restoreDisplayMode="values" />
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex min-h-72 items-center justify-center px-6 text-center">
                  <div className="max-w-sm">
                    <CalendarClock className="mx-auto size-6 text-muted-foreground" aria-hidden />
                    <p className="mt-3 font-medium text-sm">Content remains sealed</p>
                    <p className="mt-1 text-muted-foreground text-sm">
                      Select a retained chat, then open its transcript. The access is recorded.
                    </p>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </main>
  );
}

function RetainedRow({
  thread,
  selected,
  onSelect,
}: {
  thread: RetainedThreadSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "mb-1 w-full rounded-lg px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-accent text-accent-foreground",
      )}
    >
      <span className="block truncate font-medium text-sm">{thread.threadId}</span>
      <span className="mt-1 block truncate text-muted-foreground text-xs">Owner {thread.ownerUserId}</span>
      <span className="mt-1 block text-muted-foreground text-xs">
        Created {formatDateTime(thread.createdAt)} · updated {formatDateTime(thread.updatedAt)}
      </span>
      <span className="mt-1 block text-muted-foreground text-xs">
        Deleted {formatDateTime(thread.deletedAt)} · purge {formatDateTime(thread.purgeAfter)}
      </span>
      <span className="mt-1 block text-muted-foreground text-xs">
        {thread.messageCount} {thread.messageCount === 1 ? "message" : "messages"}
      </span>
    </button>
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
