import { fetchServerSentEvents, type UIMessage, useChat } from "@tanstack/ai-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CreateWorkspaceDialog } from "@/components/onboarding/CreateWorkspaceDialog";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  extractDocumentAttachment,
  formatBytes,
  isSupportedTextFile,
  MAX_DOCUMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  needsExtraction,
  type TextAttachment,
  textAttachmentFromFile,
} from "@/lib/file-attachments";
import { MODELS, type ModelChoice } from "@/lib/models";
import type { ProtectionStatus } from "@/lib/protection-status";
import { uiToStored } from "@/lib/storage/messages";
import { invalidateThreads, threadKeys } from "@/lib/storage/threadQueries";
import { saveThread, startThread } from "@/lib/storage/threads";
import {
  type InstanceSettings,
  isModelAllowed,
  modelKey,
  type ThreadSummary,
  type UserSettings,
} from "@/lib/storage/types";
import { useInstanceSettings } from "@/lib/storage/useInstanceSettings";
import { useProtectionStatus } from "@/lib/use-protection-status";
import { useSidebar } from "@/lib/use-sidebar";
import { ChatSidebar } from "./ChatSidebar";
import { Composer, type ComposerHandle } from "./Composer";
import { ErrorBanner } from "./ErrorBanner";
import { MessageList } from "./MessageList";
import { ProtectionNotice } from "./ProtectionNotice";
import { TopBar } from "./TopBar";

/** Pick the model a new chat opens on: the user's default if the instance still allows it, else the first
 * allowed model, else the first model (allow-list can't be empty in practice — empty means "all"). */
function initialModel(userSettings: UserSettings | undefined, instance: InstanceSettings): ModelChoice {
  const allowed = MODELS.filter((m) => isModelAllowed(instance, modelKey(m)));
  const dm = userSettings?.defaultModel;
  const preferred = allowed.find((m) => m.provider === dm?.provider && m.model === dm?.model);
  return preferred ?? allowed[0] ?? MODELS[0];
}

/**
 * Owns the conversation: the useChat client, the composer input, and the model choice. A fresh chat on
 * `/` generates its own thread id and, once the first exchange completes, persists a snapshot and syncs
 * the URL to `/chat/<id>`. An existing thread is hydrated by the `/chat/$threadId` route via
 * `initialMessages` and keeps saving snapshots as the conversation grows.
 */
export function ChatView({
  userSettings,
  threadId,
  initialMessages,
}: {
  userSettings?: UserSettings;
  threadId?: string;
  initialMessages?: UIMessage[];
} = {}) {
  const queryClient = useQueryClient();
  const instance = useInstanceSettings();
  const sidebar = useSidebar();
  const protectionStatus = useProtectionStatus();
  const composerRef = useRef<ComposerHandle>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [confirmSendOpen, setConfirmSendOpen] = useState(false);
  // Passthrough (unprotected but working) asks for consent once per chat, not on every send.
  const [passthroughAck, setPassthroughAck] = useState(false);
  const [input, setInput] = useState("");
  const [model, setModel] = useState<ModelChoice>(() => initialModel(userSettings, instance));
  const [attachments, setAttachments] = useState<TextAttachment[]>([]);
  const [uploadWarning, setUploadWarning] = useState<string[]>();
  const [isExtracting, setIsExtracting] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState(threadId);

  // A new chat gets a stable id up front so its snapshot has a home before the first save.
  const tid = useMemo(() => threadId ?? crypto.randomUUID(), [threadId]);
  const forwardedProps = useMemo(
    () => ({ provider: model.provider, model: model.model }),
    [model.provider, model.model],
  );

  const { messages, sendMessage, isLoading, error, stop, reload, clear } = useChat({
    connection: fetchServerSentEvents("/api/chat"),
    forwardedProps,
    id: tid,
    threadId: tid,
    initialMessages,
    onFinish: (message) => persist(message),
  });

  // Latest messages for the fire-and-forget save (onFinish fires outside React's render).
  const messagesRef = useRef<UIMessage[]>(messages);
  messagesRef.current = messages;
  const urlSynced = useRef(false);
  const startingThread = useRef(false);

  const syncNewThreadUrl = () => {
    if (threadId || urlSynced.current) return;
    // Reflect the new thread without a navigation, which would re-run the loader and remount this component
    // mid-session. A reload then lands on the thread route.
    window.history.replaceState(null, "", `/chat/${tid}`);
    urlSynced.current = true;
    setActiveThreadId(tid);
  };

  const persistSnapshot = async (snapshot: UIMessage[]) => {
    if (snapshot.length === 0) return;
    queryClient.setQueryData<ThreadSummary[]>(threadKeys.all, (current) => upsertThreadSummary(current, tid, snapshot));
    try {
      await saveThread({ data: { threadId: tid, messages: snapshot.map(uiToStored) } });
      void invalidateThreads(queryClient);
    } catch (err) {
      console.warn("Failed to save chat thread", err);
      // Persistence is best-effort — a failed save must never break the live chat — but it shouldn't be
      // silent either: a user whose history quietly stops saving deserves to know. Stable id dedupes so
      // repeated save failures update one toast instead of stacking.
      toast.error("This chat isn't being saved to your history right now. Your conversation is still here.", {
        id: "thread-save-failed",
      });
    }
  };

  const startThreadNow = (message: UIMessage) => {
    const snapshot = [...messagesRef.current, message];
    // Show the new chat in the sidebar immediately, but don't touch URL/router or active-thread state while
    // the first stream is starting; those visible navigation updates can disturb TanStack AI's first response.
    queryClient.setQueryData<ThreadSummary[]>(threadKeys.all, (current) => upsertThreadSummary(current, tid, snapshot));
    void startThread({ data: { threadId: tid, message: uiToStored(message) } }).catch((err) => {
      console.warn("Failed to start chat thread", err);
    });
  };

  const persist = (finishedMessage?: UIMessage) => {
    const snapshot = snapshotWithFinishedMessage(messagesRef.current, finishedMessage);
    syncNewThreadUrl();
    void persistSnapshot(snapshot);
  };

  // Whether the current protection posture allows sending, blocks it, or needs a one-time acknowledgement.
  const posture = sendPosture(protectionStatus);

  const dispatchSend = (text: string) => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || isLoading || isExtracting || startingThread.current) return;
    const content = messageWithAttachments(trimmed, attachments);
    const startedMessage = messagesRef.current.length === 0 ? userMessage(content) : undefined;
    setInput("");
    setAttachments([]);
    setUploadWarning(undefined);

    startingThread.current = true;
    const sendPromise = sendMessage(content);
    // `sendMessage()` awaits TanStack AI's internal onResponse hook before it starts `connection.send()`.
    // A microtask can still run inside that gap, so schedule thread/sidebar/URL work as a macrotask to avoid
    // perturbing the first stream startup path.
    if (startedMessage) setTimeout(() => startThreadNow(startedMessage), 0);
    void sendPromise.finally(() => {
      startingThread.current = false;
    });
  };

  // Gate the raw dispatch on protection posture so the Send affordance can't outrun the banner: a blocked
  // posture never reaches here (the button is disabled), and passthrough asks once before sending unprotected.
  const send = (text: string) => {
    if (posture.kind === "blocked") return;
    if (posture.kind === "passthrough" && !passthroughAck) {
      if (!text.trim() && attachments.length === 0) return;
      setConfirmSendOpen(true);
      return;
    }
    dispatchSend(text);
  };

  const confirmPassthroughSend = () => {
    setPassthroughAck(true);
    setConfirmSendOpen(false);
    dispatchSend(input);
  };

  // Suggestions prime the composer instead of sending: the copy references a document the user still needs
  // to paste or attach, so firing a send here would dead-end on empty context.
  const pickSuggestion = (prompt: string) => {
    setInput(prompt);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const handleFilesSelected = async (files: File[]) => {
    const nextAttachments: TextAttachment[] = [];
    const toExtract: File[] = [];
    const warnings: string[] = [];

    for (const file of files) {
      // PDF/DOCX can't be read as text in the browser — defer them to server-side extraction below.
      if (needsExtraction(file)) {
        if (file.size > MAX_DOCUMENT_BYTES) {
          warnings.push(
            `${file.name || "That document"} is ${formatBytes(file.size)}; keep documents under ${formatBytes(
              MAX_DOCUMENT_BYTES,
            )}.`,
          );
          continue;
        }
        toExtract.push(file);
        continue;
      }

      if (!isSupportedTextFile(file)) {
        warnings.push(`${file.name || "That file"} was not attached. Only text and PDF/DOCX files are supported.`);
        continue;
      }

      if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
        warnings.push(
          `${file.name || "That file"} is ${formatBytes(file.size)}; keep text attachments under ${formatBytes(
            MAX_TEXT_ATTACHMENT_BYTES,
          )} for now.`,
        );
        continue;
      }

      try {
        const attachment = await textAttachmentFromFile(file);
        if (!attachment.content.trim()) {
          warnings.push(`${attachment.name} is empty, so it was not attached.`);
          continue;
        }
        nextAttachments.push(attachment);
      } catch {
        warnings.push(`${file.name || "That file"} could not be read. Paste the text instead.`);
      }
    }

    if (nextAttachments.length > 0) setAttachments((current) => [...current, ...nextAttachments]);

    // Extraction is a network round-trip per document (slow with OCR), so attach each as it resolves and
    // gate sending until they finish. A failure warns and drops that document — never sent un-extracted.
    if (toExtract.length > 0) {
      setIsExtracting(true);
      try {
        for (const file of toExtract) {
          try {
            const attachment = await extractDocumentAttachment(file);
            setAttachments((current) => [...current, attachment]);
          } catch (err) {
            warnings.push(
              err instanceof Error ? err.message : `${file.name || "That document"} could not be extracted.`,
            );
          }
        }
      } finally {
        setIsExtracting(false);
      }
    }

    setUploadWarning(warnings.length > 0 ? warnings : undefined);
  };

  const resetChat = () => {
    // Guard an unsent draft: starting a new chat below discards the composer, so confirm first rather
    // than silently dropping typed text or staged attachments.
    const hasDraft = input.trim().length > 0 || attachments.length > 0;
    if (hasDraft && !window.confirm("Discard your unsent message and start a new chat?")) return;

    // Start a genuinely new thread: navigate to `/`, which mounts a fresh ChatView with a new thread id.
    // (clear() alone would reuse this id and overwrite the current thread, and the URL may already be
    // synced to /chat/<id> from persist().) A hard assign guarantees a clean remount.
    if (threadId || messages.length > 0) {
      window.location.assign("/");
      return;
    }
    clear();
    setInput("");
    setAttachments([]);
    setUploadWarning(undefined);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-dvh overflow-hidden bg-background text-foreground">
        <ChatSidebar
          open={sidebar.open}
          onToggle={sidebar.toggle}
          onClose={sidebar.close}
          onNewChat={resetChat}
          onOpenSettings={() => setSettingsOpen(true)}
          onCreateWorkspace={() => setCreateWorkspaceOpen(true)}
          activeThreadId={activeThreadId}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            model={model}
            onModelChange={setModel}
            busy={isLoading}
            sidebarOpen={sidebar.open}
            onToggleSidebar={sidebar.toggle}
            protectionStatus={protectionStatus}
          />

          <MessageList
            messages={messages}
            isLoading={isLoading}
            onRegenerate={reload}
            onPickSuggestion={pickSuggestion}
          />

          {error ? (
            <div className="pb-2">
              <ErrorBanner message={error.message} onRetry={isLoading ? undefined : reload} />
            </div>
          ) : null}

          <ProtectionNotice status={protectionStatus} />

          <Composer
            ref={composerRef}
            value={input}
            onChange={setInput}
            onSubmit={() => send(input)}
            onStop={stop}
            isLoading={isLoading}
            isExtracting={isExtracting}
            disabledReason={posture.kind === "blocked" ? posture.reason : undefined}
            attachments={attachments}
            uploadWarning={uploadWarning}
            autoFocus={!threadId && messages.length === 0}
            onFilesSelected={handleFilesSelected}
            onRemoveAttachment={(id) =>
              setAttachments((current) => current.filter((attachment) => attachment.id !== id))
            }
            onDismissUploadWarning={() => setUploadWarning(undefined)}
          />
        </div>

        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} userSettings={userSettings} />
        <CreateWorkspaceDialog open={createWorkspaceOpen} onOpenChange={setCreateWorkspaceOpen} />

        <Dialog open={confirmSendOpen} onOpenChange={setConfirmSendOpen}>
          <DialogContent showCloseButton={false} className="max-w-md">
            <DialogHeader>
              <DialogTitle>Send without protection?</DialogTitle>
              <DialogDescription>
                No secrets are registered yet, so this message goes to the AI provider unchanged. ficta won't ask again
                for this chat.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setConfirmSendOpen(false)}>
                Cancel
              </Button>
              <Button onClick={confirmPassthroughSend}>Send anyway</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

type SendPosture = { kind: "ok" } | { kind: "passthrough" } | { kind: "blocked"; reason: string };

/**
 * Map protection posture to what Send is allowed to do, so the composer can't promise more than the proxy
 * will deliver. Blocked = sending literally can't succeed (proxy down or fail-closed); passthrough = it
 * works but nothing is protected, so ask once. An unknown/loading status stays "ok" — don't block the very
 * first send on a status check that's still in flight.
 */
function sendPosture(status: ProtectionStatus | undefined): SendPosture {
  if (!status) return { kind: "ok" };
  if (!status.ok) {
    return {
      kind: "blocked",
      reason:
        status.status === "unreachable"
          ? "ficta isn't connected, so messages can't be sent yet."
          : "ficta protection can't be confirmed, so messages can't be sent.",
    };
  }
  if (status.pii.status === "blocking") {
    return { kind: "blocked", reason: "Chat is paused until ficta protection recovers." };
  }
  if (!status.protection.protecting) return { kind: "passthrough" };
  return { kind: "ok" };
}

function userMessage(content: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", content }],
    createdAt: new Date(),
  };
}

function snapshotWithFinishedMessage(messages: UIMessage[], finishedMessage: UIMessage | undefined): UIMessage[] {
  if (!finishedMessage) return messages;
  const existingIndex = messages.findIndex((message) => message.id === finishedMessage.id);
  if (existingIndex === -1) return [...messages, finishedMessage];
  return messages.map((message, index) => (index === existingIndex ? finishedMessage : message));
}

function upsertThreadSummary(
  current: ThreadSummary[] | undefined,
  threadId: string,
  messages: UIMessage[],
): ThreadSummary[] {
  const now = new Date().toISOString();
  const existing = current?.find((thread) => thread.id === threadId);
  const summary: ThreadSummary = {
    id: threadId,
    title: existing?.title ?? deriveTitle(messages),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return [summary, ...(current ?? []).filter((thread) => thread.id !== threadId)];
}

function deriveTitle(messages: UIMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  const text = firstUser?.parts
    .filter((part) => part.type === "text")
    .map((part) => part.content)
    .join(" ");
  return text?.replace(/\s+/g, " ").trim().slice(0, 80) || "New chat";
}

function messageWithAttachments(text: string, attachments: TextAttachment[]): string {
  if (attachments.length === 0) return text;

  const fileContext = attachments
    .map((attachment, index) =>
      [
        `Attached text file ${index + 1} (filename omitted for privacy, ${formatBytes(attachment.size)}):`,
        "<file_content>",
        attachment.content.trimEnd(),
        "</file_content>",
      ].join("\n"),
    )
    .join("\n\n");

  if (!text) return `Please review the attached text file content.\n\n${fileContext}`;
  return `${fileContext}\n\nUser request:\n${text}`;
}
