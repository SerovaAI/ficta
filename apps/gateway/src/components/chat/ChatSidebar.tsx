import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { PanelLeft, PanelLeftClose, Plus, Settings, Shield, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isAdmin } from "@/lib/auth/types";
import { useAuthState } from "@/lib/auth/useAuthState";
import { cancelThreadDeletion, scheduleThreadDeletion } from "@/lib/storage/threadDeletion";
import { threadKeys, threadsQueryOptions } from "@/lib/storage/threadQueries";
import { deleteThread } from "@/lib/storage/threads";
import type { ThreadSummary } from "@/lib/storage/types";
import { useInstanceSettings } from "@/lib/storage/useInstanceSettings";
import { cn } from "@/lib/utils";
import { UserMenu } from "./UserMenu";

/**
 * Collapsible chat-history sidebar. On `md+` it's a persistent column that collapses to a 48px icon rail
 * (expand + New chat) rather than hiding; below `md` it's an off-canvas overlay drawer with a backdrop that
 * hides fully when closed. Lists the viewer's threads (cheap summaries, no bodies) and links each to its
 * `/chat/$threadId` route. Reuses the `threads.ts` server fns — no DB code enters the client.
 *
 * The list is backed by TanStack Query, so chat creation/deletion can invalidate or update one shared cache
 * instead of relying on a one-off mount fetch. Storage is always on, so this is always shown.
 */
export function ChatSidebar({
  open,
  onToggle,
  onClose,
  onNewChat,
  onOpenAdmin,
  onOpenSettings,
  onCreateWorkspace,
  activeThreadId,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onNewChat: () => void;
  onOpenAdmin?: () => void;
  onOpenSettings: () => void;
  onCreateWorkspace: () => void;
  activeThreadId?: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { instanceName } = useInstanceSettings();
  const auth = useAuthState();
  const { user } = auth;
  const hostedAuth = auth.requiresAuth;
  const showAdmin = isAdmin(auth) && onOpenAdmin !== undefined;
  const threadsQuery = useQuery(threadsQueryOptions);
  const threads = threadsQuery.data ?? [];

  // Selecting a thread should dismiss the overlay drawer on mobile, but leave the persistent desktop column
  // open. There's no matching desktop close-on-navigate, so this is viewport-gated rather than always-close.
  const closeOnMobile = () => {
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) onClose();
  };

  const startNewChat = () => {
    closeOnMobile();
    onNewChat();
  };

  const openSettings = () => {
    closeOnMobile();
    onOpenSettings();
  };

  const openAdmin = () => {
    closeOnMobile();
    onOpenAdmin?.();
  };

  const createWorkspace = () => {
    closeOnMobile();
    onCreateWorkspace();
  };

  const remove = (event: React.MouseEvent, thread: ThreadSummary) => {
    // The delete control overlays the row's Link; keep the click from following it.
    event.preventDefault();
    event.stopPropagation();
    const id = thread.id;
    const wasActive = id === activeThreadId;
    const previous = queryClient.getQueryData<ThreadSummary[]>(threadKeys.all);

    // Optimistically remove the row and, if it's the open conversation, leave its now-orphaned view.
    queryClient.setQueryData<ThreadSummary[]>(threadKeys.all, (current) => current?.filter((t) => t.id !== id) ?? []);
    if (wasActive) navigate({ to: "/" });

    // Defer the destructive server call so Undo can cancel it outright (see threadDeletion.ts).
    scheduleThreadDeletion(id, async () => {
      try {
        await deleteThread({ data: { threadId: id } });
        void queryClient.invalidateQueries({ queryKey: threadKeys.all });
      } catch {
        queryClient.setQueryData(threadKeys.all, previous);
        toast.error("Couldn't delete that chat — it's back in your history.");
      }
    });

    toast(`Deleted "${truncateTitle(thread.title)}"`, {
      action: {
        label: "Undo",
        onClick: () => {
          if (!cancelThreadDeletion(id)) return;
          queryClient.setQueryData(threadKeys.all, previous);
          if (wasActive) navigate({ to: "/chat/$threadId", params: { threadId: id } });
        },
      },
    });
  };

  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
        />
      ) : null}
      <aside
        className={cn(
          "flex h-dvh w-[260px] shrink-0 flex-col border-r border-border bg-background transition-[width,transform] duration-200",
          // Desktop: never hides — full column when open, 48px icon rail when collapsed.
          open ? "md:w-[260px]" : "md:w-12",
          // Mobile: off-canvas overlay drawer that fully hides when closed.
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:shadow-xl",
          open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
        )}
      >
        {open ? (
          <>
            <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
              <div className="flex min-w-0 items-center gap-2">
                <BrandMark />
                <TextWordmark value={instanceName ?? "ficta"} />
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={onToggle} aria-label="Collapse sidebar">
                    <PanelLeftClose className="size-4" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Collapse</TooltipContent>
              </Tooltip>
            </div>

            {/* New chat is an action in the sidebar body, not the header — same standalone role it has in
                the collapsed rail. */}
            <div className="space-y-2 p-2 pb-0">
              <Button variant="outline" className="w-full justify-start gap-2" onClick={startNewChat}>
                <Plus className="size-4" aria-hidden />
                New chat
              </Button>
              {showAdmin && !user ? (
                <Button variant="ghost" className="w-full justify-start gap-2" onClick={openAdmin}>
                  <Shield className="size-4" aria-hidden />
                  Admin
                </Button>
              ) : null}
            </div>

            <nav className="flex-1 overflow-y-auto p-2">
              {threadsQuery.isPending ? (
                <p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>
              ) : threads.length === 0 ? (
                <p className="px-2 py-2 text-sm text-muted-foreground">No saved chats yet</p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {threads.map((thread) => (
                    <li key={thread.id} className="group relative">
                      <Link
                        to="/chat/$threadId"
                        params={{ threadId: thread.id }}
                        onClick={closeOnMobile}
                        className={cn(
                          "flex items-center rounded-md py-1.5 pr-9 pl-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground [@media(pointer:coarse)]:min-h-11",
                          thread.id === activeThreadId && "bg-accent text-accent-foreground",
                        )}
                      >
                        <span className="truncate">{thread.title}</span>
                      </Link>
                      <button
                        type="button"
                        aria-label="Delete chat"
                        onClick={(event) => remove(event, thread)}
                        className="absolute top-1/2 right-1 flex size-8 shrink-0 -translate-y-1/2 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:size-11"
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </nav>

            {/* Account footer, pinned to the bottom by the flex-1 nav above. The menu opens upward. */}
            <div className="shrink-0 border-t border-border p-2">
              {user ? (
                <UserMenu
                  user={user}
                  description={hostedAuth ? undefined : "No sign-in required"}
                  variant="row"
                  side="top"
                  align="start"
                  onOpenAdmin={showAdmin ? openAdmin : undefined}
                  onOpenSettings={openSettings}
                  onCreateWorkspace={createWorkspace}
                  showWorkspaces={hostedAuth}
                  showSignOut={hostedAuth}
                />
              ) : (
                <Button
                  variant="ghost"
                  className="h-auto w-full justify-start gap-2 px-2 py-1.5"
                  onClick={openSettings}
                >
                  <Settings className="size-4" aria-hidden />
                  <span className="text-sm font-medium">Settings</span>
                </Button>
              )}
            </div>
          </>
        ) : (
          // Collapsed icon rail (desktop only — on mobile the whole aside is off-canvas).
          <>
            {/* Same h-14 header + divider as the expanded state, so the horizon line stays put. The brand
                mark is the expand control and swaps to an expand icon on hover. */}
            <div className="flex h-14 shrink-0 items-center justify-center border-b border-border">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onToggle}
                    aria-label="Expand sidebar"
                    className="group flex size-7 items-center justify-center rounded-lg border border-border bg-[#0A0A0C] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:size-11"
                  >
                    <BrandGlyph className="size-[18px] group-hover:hidden" />
                    <PanelLeft className="hidden size-4 text-[#F3F1EA] group-hover:block" aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Expand</TooltipContent>
              </Tooltip>
            </div>
            <div className="flex flex-col items-center gap-2 py-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={startNewChat} aria-label="New chat">
                    <Plus className="size-4" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">New chat</TooltipContent>
              </Tooltip>
              {showAdmin && !user ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" onClick={openAdmin} aria-label="Admin">
                      <Shield className="size-4" aria-hidden />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Admin</TooltipContent>
                </Tooltip>
              ) : null}
            </div>

            {/* Account/settings pinned to the bottom of the rail. The avatar carries its own dropdown, so
                it isn't wrapped in a tooltip (that would fight the menu trigger for the same button). */}
            <div className="mt-auto flex flex-col items-center gap-2 pb-2">
              {user ? (
                <UserMenu
                  user={user}
                  description={hostedAuth ? undefined : "No sign-in required"}
                  variant="icon"
                  side="right"
                  align="end"
                  onOpenAdmin={showAdmin ? openAdmin : undefined}
                  onOpenSettings={openSettings}
                  onCreateWorkspace={createWorkspace}
                  showWorkspaces={hostedAuth}
                  showSignOut={hostedAuth}
                />
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" onClick={openSettings} aria-label="Settings">
                      <Settings className="size-4" aria-hidden />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Settings</TooltipContent>
                </Tooltip>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

/** Keep the delete toast readable — a long thread title shouldn't blow out the toast width. */
function truncateTitle(title: string): string {
  return title.length > 40 ? `${title.slice(0, 39).trimEnd()}…` : title;
}

/** Product wordmark for the sidebar title. Brackets carry the fixed brand color; the value text follows
 * the current foreground so it stays legible in both themes. */
function TextWordmark({ value }: { value: string }) {
  return (
    <span
      role="img"
      aria-label={value}
      className="inline-flex min-w-0 max-w-full items-baseline font-mono text-base font-normal leading-none tracking-tight"
    >
      <span aria-hidden="true" className="shrink-0 text-[#F1552F]">
        [
      </span>
      <span className="truncate">{value}</span>
      <span aria-hidden="true" className="shrink-0 text-[#F1552F]">
        ]
      </span>
    </span>
  );
}

/** The ficta mark (assets/brand, "Token Wrapper"): vermilion brackets wrapping a chalk value block.
 * Brand colors are fixed hexes, not theme tokens — the mark never re-tints with the theme. */
function BrandGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect x="14" y="16" width="6" height="32" rx="2" fill="#F1552F" />
      <rect x="14" y="16" width="14" height="6" rx="2" fill="#F1552F" />
      <rect x="14" y="42" width="14" height="6" rx="2" fill="#F1552F" />
      <rect x="44" y="16" width="6" height="32" rx="2" fill="#F1552F" />
      <rect x="36" y="16" width="14" height="6" rx="2" fill="#F1552F" />
      <rect x="36" y="42" width="14" height="6" rx="2" fill="#F1552F" />
      <rect x="27" y="26" width="10" height="12" rx="2" fill="#F3F1EA" />
    </svg>
  );
}

/** ficta's brand mark — the Token Wrapper glyph on its ink app-icon tile, so it reads in both themes.
 * Shown beside the wordmark when expanded and alone (as the expand affordance) in the collapsed rail. */
function BrandMark() {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-[#0A0A0C]">
      <BrandGlyph className="size-[18px]" />
    </span>
  );
}
