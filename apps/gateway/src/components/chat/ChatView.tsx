import { fetchServerSentEvents, type UIMessage, useChat } from "@tanstack/ai-react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CreateWorkspaceDialog } from "@/components/onboarding/CreateWorkspaceDialog";
import { AdminSettingsDialog } from "@/components/settings/AdminSettingsDialog";
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
import { isAdmin } from "@/lib/auth/types";
import { useAuthState } from "@/lib/auth/useAuthState";
import { hasComposerDraft } from "@/lib/composer-submit";
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
import {
  DEFAULT_REASONING_EFFORT,
  MODELS,
  type ModelChoice,
  normalizeReasoningEffort,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "@/lib/models";
import { withOneShotProtectionTicket } from "@/lib/protection-connection";
import { type GatewayProtectionPreview, previewProtection } from "@/lib/protection-preview";
import { type ProtectionStatus, requiredRegistryBlock } from "@/lib/protection-status";
import { fetchProxyConfig } from "@/lib/proxy-config";
import {
  type ProtectionHighlightAnnotation,
  previewFindingsToAnnotations,
  type RestoreHighlightDisplayMode,
  withProtectionAnnotations,
} from "@/lib/restore-highlights";
import { reportRestoreValidation } from "@/lib/restore-validation";
import { uiToStored } from "@/lib/storage/messages";
import { suggestProtectedRegistryEntries } from "@/lib/storage/protected-registry";
import { invalidateThreads, threadKeys } from "@/lib/storage/threadQueries";
import { saveThread, setThreadTraceEnabled, startThread } from "@/lib/storage/threads";
import {
  type InstanceSettings,
  isModelAllowed,
  modelKey,
  type ThreadSummary,
  type UserSettings,
} from "@/lib/storage/types";
import { useInstanceSettings } from "@/lib/storage/useInstanceSettings";
import { deriveThreadTitleFromText } from "@/lib/thread-title";
import { shouldClearThreadTrace } from "@/lib/trace-capture";
import { useProtectionStatus } from "@/lib/use-protection-status";
import { clearRestoreHighlightDisplay, useRestoreHighlightDisplay } from "@/lib/use-restore-highlight-display";
import { useSidebar } from "@/lib/use-sidebar";
import { ChatSidebar } from "./ChatSidebar";
import { Composer, type ComposerHandle } from "./Composer";
import { ErrorBanner } from "./ErrorBanner";
import { MessageList } from "./MessageList";
import { ProtectionNotice } from "./ProtectionNotice";
import { ProtectionReview, ProtectionReviewLoading } from "./ProtectionReview";
import { draftWithSuggestion } from "./suggestionDraft";
import { ThreadEvidenceDialog } from "./ThreadEvidenceDialog";
import { TopBar } from "./TopBar";

/** Pick the model a new chat opens on: the user's default if the instance still allows it, else the first
 * allowed model, else the first model (allow-list can't be empty in practice — empty means "all"). */
function initialModel(userSettings: UserSettings | undefined, instance: InstanceSettings): ModelChoice {
  const allowed = MODELS.filter((m) => isModelAllowed(instance, modelKey(m)));
  const dm = userSettings?.defaultModel;
  const preferred = allowed.find((m) => m.provider === dm?.provider && m.model === dm?.model);
  return preferred ?? allowed[0] ?? MODELS[0];
}

function initialReasoningEffort(userSettings: UserSettings | undefined, model: ModelChoice): ReasoningEffort {
  return normalizeReasoningEffort(model, userSettings?.defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT);
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
  initialThreadTraceEnabled,
}: {
  userSettings?: UserSettings;
  threadId?: string;
  initialMessages?: UIMessage[];
  initialThreadTraceEnabled?: boolean;
} = {}) {
  const queryClient = useQueryClient();
  const auth = useAuthState();
  const admin = isAdmin(auth);
  const instance = useInstanceSettings();
  const sidebar = useSidebar();
  const protectionStatus = useProtectionStatus();
  const composerRef = useRef<ComposerHandle>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [confirmSendOpen, setConfirmSendOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  // Passthrough (unprotected but working) asks for consent once per chat, not on every send.
  const [passthroughAck, setPassthroughAck] = useState(false);
  const [input, setInput] = useState("");
  const [model, setModel] = useState<ModelChoice>(() => initialModel(userSettings, instance));
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(() =>
    initialReasoningEffort(userSettings, initialModel(userSettings, instance)),
  );
  const [restoreDisplayMode, setRestoreDisplayMode] = useState<RestoreHighlightDisplayMode>("values");
  const [attachments, setAttachments] = useState<TextAttachment[]>([]);
  const [uploadWarning, setUploadWarning] = useState<string[]>();
  const [isExtracting, setIsExtracting] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState(threadId);
  const [threadTraceEnabled, setThreadTraceEnabledState] = useState(initialThreadTraceEnabled ?? false);
  const [threadTraceError, setThreadTraceError] = useState(false);
  const [reviewBeforeSend, setReviewBeforeSend] = useState(true);
  const [traceCapture, setTraceCapture] = useState({
    loaded: false,
    known: false,
    rawBodies: false,
    traceAudit: false,
  });
  const [saveWarning, setSaveWarning] = useState(false);
  const pendingProtectionTicket = useRef<string | undefined>(undefined);
  const protectionPreviewRequest = useRef<{ generation: number; controller?: AbortController }>({ generation: 0 });
  const [protectionReview, setProtectionReview] = useState<{
    text: string;
    preview: GatewayProtectionPreview;
    newlyProtectedValues: string[];
    action: "send" | "reload";
  }>();
  const [protectionReviewLoading, setProtectionReviewLoading] = useState(false);
  const [protectionReviewError, setProtectionReviewError] = useState("");
  const [protectionReviewNotice, setProtectionReviewNotice] = useState("");

  // A new chat gets a stable id up front so its snapshot has a home before the first save.
  const tid = useMemo(() => threadId ?? crypto.randomUUID(), [threadId]);
  const forwardedProps = useMemo(
    () => ({
      provider: model.provider,
      model: model.model,
      reasoningEffort,
      traceEnabled: threadTraceEnabled,
    }),
    [model.provider, model.model, reasoningEffort, threadTraceEnabled],
  );
  const chatConnection = useMemo(
    () => withOneShotProtectionTicket(fetchServerSentEvents("/api/chat"), pendingProtectionTicket),
    [],
  );

  const { messages, sendMessage, isLoading, error, stop, reload, clear, setMessages } = useChat({
    connection: chatConnection,
    forwardedProps,
    id: tid,
    threadId: tid,
    initialMessages,
    onFinish: (message) => {
      persist(message);
      reportRestoreValidation(message); // gateway-only telemetry: flag any surrogate that reached the user un-restored
    },
  });

  // Latest messages for the fire-and-forget save (onFinish fires outside React's render).
  const messagesRef = useRef<UIMessage[]>(messages);
  messagesRef.current = messages;
  const urlSynced = useRef(false);
  const startingThread = useRef(false);
  const {
    displayMessages,
    restoreHighlightsAvailable,
    prepareMessagesForPersistence,
    clearRestoreHighlightsAtPosition,
  } = useRestoreHighlightDisplay(tid, messages);

  const cancelProtectionPreview = () => {
    protectionPreviewRequest.current.controller?.abort();
    protectionPreviewRequest.current = { generation: protectionPreviewRequest.current.generation + 1 };
  };

  const startProtectionPreview = () => {
    cancelProtectionPreview();
    const controller = new AbortController();
    const generation = protectionPreviewRequest.current.generation;
    protectionPreviewRequest.current = { generation, controller };
    return { controller, generation };
  };

  const protectionPreviewIsCurrent = (generation: number) =>
    protectionPreviewRequest.current.generation === generation &&
    protectionPreviewRequest.current.controller?.signal.aborted === false;

  const chooseModel = (choice: ModelChoice) => {
    setModel(choice);
    setReasoningEffort((current) => normalizeReasoningEffort(choice, current));
  };

  useEffect(() => {
    setThreadTraceEnabledState(initialThreadTraceEnabled ?? false);
  }, [initialThreadTraceEnabled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset all chat-scoped review state when the route changes
  useEffect(() => {
    cancelProtectionPreview();
    pendingProtectionTicket.current = undefined;
    setReviewBeforeSend(true);
    setThreadTraceError(false);
    setProtectionReview(undefined);
    setProtectionReviewLoading(false);
    setProtectionReviewError("");
    setProtectionReviewNotice("");
  }, [threadId]);

  useEffect(
    () => () => {
      protectionPreviewRequest.current.controller?.abort();
      protectionPreviewRequest.current = { generation: protectionPreviewRequest.current.generation + 1 };
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    if (!admin) {
      setTraceCapture({ loaded: true, known: false, rawBodies: false, traceAudit: false });
      return () => {
        alive = false;
      };
    }
    // Refresh when the admin dialog closes so a runtime grant changed there becomes usable in chat.
    if (adminOpen) {
      return () => {
        alive = false;
      };
    }
    setTraceCapture((current) => ({ ...current, loaded: false }));
    fetchProxyConfig()
      .then((config) => {
        if (!alive) return;
        const traceCapture = config.ok ? config.config.transport.traceCapture : undefined;
        setTraceCapture({
          loaded: true,
          known: config.ok,
          rawBodies: traceCapture?.enabled ?? false,
          traceAudit: config.ok ? config.config.transport.traceAudit : false,
        });
      })
      .catch(() => {
        if (alive) setTraceCapture({ loaded: true, known: false, rawBodies: false, traceAudit: false });
      });
    return () => {
      alive = false;
    };
  }, [admin, adminOpen]);

  // Runtime capture is one half of the dual opt-in. If an administrator turns that capability off,
  // clear this chat's selector too so turning the capability on later cannot silently resume capture.
  useEffect(() => {
    if (!shouldClearThreadTrace(admin, traceCapture, threadTraceEnabled)) return;
    setThreadTraceEnabledState(false);
    if (!activeThreadId) return;
    queryClient.setQueryData<ThreadSummary[]>(threadKeys.all, (current) =>
      current?.map((thread) => (thread.id === activeThreadId ? { ...thread, traceEnabled: false } : thread)),
    );
    void setThreadTraceEnabled({ data: { threadId: activeThreadId, traceEnabled: false } })
      .then(() => invalidateThreads(queryClient))
      .catch((err) => {
        console.warn("Failed to clear thread trace capture after runtime capture was disabled", err);
        setThreadTraceError(true);
      });
  }, [activeThreadId, admin, queryClient, threadTraceEnabled, traceCapture]);

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
    const persistable = prepareMessagesForPersistence(snapshot);
    queryClient.setQueryData<ThreadSummary[]>(threadKeys.all, (current) =>
      upsertThreadSummary(current, tid, persistable),
    );
    try {
      await saveThread({ data: { threadId: tid, messages: persistable.map(uiToStored) } });
      void invalidateThreads(queryClient);
      setSaveWarning(false);
    } catch (err) {
      console.warn("Failed to save chat thread", err);
      // Persistence is best-effort — a failed save must never break the live chat — but it shouldn't be
      // silent either: a user whose history quietly stops saving deserves to know.
      setSaveWarning(true);
    }
  };

  const startThreadNow = (message: UIMessage) => {
    const snapshot = [...messagesRef.current, message];
    // Show the new chat in the sidebar immediately, but don't touch URL/router or active-thread state while
    // the first stream is starting; those visible navigation updates can disturb TanStack AI's first response.
    queryClient.setQueryData<ThreadSummary[]>(threadKeys.all, (current) => upsertThreadSummary(current, tid, snapshot));
    void startThread({ data: { threadId: tid, message: uiToStored(message), traceEnabled: threadTraceEnabled } }).catch(
      (err) => {
        console.warn("Failed to start chat thread", err);
      },
    );
  };

  const persist = (finishedMessage?: UIMessage) => {
    const snapshot = snapshotWithFinishedMessage(messagesRef.current, finishedMessage);
    syncNewThreadUrl();
    void persistSnapshot(snapshot);
  };

  // Whether the current protection posture allows sending, blocks it, or needs a one-time acknowledgement.
  const posture = sendPosture(protectionStatus);
  const protectionReviewRequired = instance.protectionReviewRequired === true;
  const reviewBeforeSendEnabled = protectionReviewRequired || reviewBeforeSend;

  const dispatchContent = (
    content: string,
    protectionTicket?: string,
    annotations: readonly ProtectionHighlightAnnotation[] = [],
  ) => {
    if (!content.trim() || isLoading || isExtracting || startingThread.current) return;
    const outgoingMessage = userMessage(content, annotations);
    const startedMessage = messagesRef.current.length === 0 ? outgoingMessage : undefined;
    setInput("");
    setAttachments([]);
    setUploadWarning(undefined);

    startingThread.current = true;
    pendingProtectionTicket.current = protectionTicket;
    const textPart = outgoingMessage.parts[0];
    const sendPromise = sendMessage({
      content: textPart?.type === "text" ? [textPart] : content,
      id: outgoingMessage.id,
    });
    // `sendMessage()` awaits TanStack AI's internal onResponse hook before it starts `connection.send()`.
    // A microtask can still run inside that gap, so schedule thread/sidebar/URL work as a macrotask to avoid
    // perturbing the first stream startup path.
    if (startedMessage) setTimeout(() => startThreadNow(startedMessage), 0);
    void sendPromise.finally(() => {
      if (pendingProtectionTicket.current === protectionTicket) pendingProtectionTicket.current = undefined;
      startingThread.current = false;
    });
  };

  const beginProtectionReview = async (text: string, action: "send" | "reload" = "send") => {
    const trimmed = text.trim();
    const content = action === "send" ? messageWithAttachments(trimmed, attachments) : trimmed;
    if (!content.trim() || isLoading || isExtracting || protectionReviewLoading || startingThread.current) return;
    setProtectionReview(undefined);
    setProtectionReviewError("");
    setProtectionReviewNotice("");
    setProtectionReviewLoading(true);
    const request = startProtectionPreview();
    try {
      const preview = await previewProtection({ threadId: tid, text: content, signal: request.controller.signal });
      if (!protectionPreviewIsCurrent(request.generation)) return;
      setProtectionReview({ text: content, preview, newlyProtectedValues: [], action });
    } catch (err) {
      if (!protectionPreviewIsCurrent(request.generation) || isAbortError(err)) return;
      setProtectionReviewError(err instanceof Error ? err.message : "Protection preview could not run.");
    } finally {
      if (protectionPreviewIsCurrent(request.generation)) setProtectionReviewLoading(false);
    }
  };

  // Gate the raw dispatch on protection posture so the Send affordance can't outrun the banner: a blocked
  // posture never reaches here (the button is disabled), and passthrough asks once before sending unprotected.
  const send = (text: string) => {
    if (posture.kind === "blocked") return;
    if (posture.kind === "passthrough" && !passthroughAck) {
      if (!hasComposerDraft(text, attachments.length)) return;
      setConfirmSendOpen(true);
      return;
    }
    if (reviewBeforeSendEnabled) void beginProtectionReview(text);
    else dispatchContent(messageWithAttachments(text.trim(), attachments));
  };

  const confirmPassthroughSend = () => {
    setPassthroughAck(true);
    setConfirmSendOpen(false);
    if (reviewBeforeSendEnabled) void beginProtectionReview(input);
    else dispatchContent(messageWithAttachments(input.trim(), attachments));
  };

  const protectSelection = async (rawValue: string) => {
    const value = rawValue.trim();
    if (!protectionReview || !value) return;
    setProtectionReviewLoading(true);
    setProtectionReviewError("");
    setProtectionReviewNotice("");
    const request = startProtectionPreview();
    try {
      const preview = await previewProtection({
        threadId: tid,
        text: protectionReview.text,
        addValues: [value],
        signal: request.controller.signal,
      });
      if (!protectionPreviewIsCurrent(request.generation))
        throw new DOMException("Protection preview replaced", "AbortError");
      setProtectionReview({
        ...protectionReview,
        preview,
        newlyProtectedValues: [...new Set([...protectionReview.newlyProtectedValues, value])],
      });
    } catch (err) {
      if (protectionPreviewIsCurrent(request.generation) && !isAbortError(err)) {
        setProtectionReviewError(err instanceof Error ? err.message : "That value could not be protected.");
      }
      throw err;
    } finally {
      if (protectionPreviewIsCurrent(request.generation)) setProtectionReviewLoading(false);
    }
  };

  const removeChatProtection = async (value: string) => {
    if (!protectionReview) return;
    setProtectionReviewLoading(true);
    setProtectionReviewError("");
    setProtectionReviewNotice("");
    const request = startProtectionPreview();
    try {
      const preview = await previewProtection({
        threadId: tid,
        text: protectionReview.text,
        removeValues: [value],
        signal: request.controller.signal,
      });
      if (!protectionPreviewIsCurrent(request.generation)) return;
      setProtectionReview({
        ...protectionReview,
        preview,
        newlyProtectedValues: protectionReview.newlyProtectedValues.filter((entry) => entry !== value),
      });
    } catch (err) {
      if (!protectionPreviewIsCurrent(request.generation) || isAbortError(err)) return;
      setProtectionReviewError(err instanceof Error ? err.message : "That chat protection could not be removed.");
    } finally {
      if (protectionPreviewIsCurrent(request.generation)) setProtectionReviewLoading(false);
    }
  };

  const suggestForWorkspace = async (values: string[]) => {
    setProtectionReviewLoading(true);
    setProtectionReviewError("");
    setProtectionReviewNotice("");
    try {
      const saved = await suggestProtectedRegistryEntries({ data: values });
      setProtectionReviewNotice(
        saved.length > 0
          ? `${saved.length} value${saved.length === 1 ? " was" : "s were"} sent to the Protected Registry for admin review.`
          : "These values are already in the Protected Registry.",
      );
      setProtectionReview((current) => (current ? { ...current, newlyProtectedValues: [] } : current));
    } catch (err) {
      setProtectionReviewError(err instanceof Error ? err.message : "Workspace suggestions could not be saved.");
    } finally {
      setProtectionReviewLoading(false);
    }
  };

  const sendProtected = () => {
    if (!protectionReview || protectionReviewLoading) return;
    const content = protectionReview.text;
    const ticket = protectionReview.preview.ticket;
    const annotations = previewFindingsToAnnotations(content, protectionReview.preview.findings);
    const action = protectionReview.action;
    setProtectionReview(undefined);
    setProtectionReviewError("");
    setProtectionReviewNotice("");
    if (action === "send") {
      dispatchContent(content, ticket, annotations);
      return;
    }
    const updatedMessages = replaceLatestUserProtectionAnnotations(messagesRef.current, annotations);
    messagesRef.current = updatedMessages;
    setMessages(updatedMessages);
    const assistantPosition = latestAssistantPosition(updatedMessages);
    if (assistantPosition !== -1) clearRestoreHighlightsAtPosition(assistantPosition);
    pendingProtectionTicket.current = ticket;
    const reloadPromise = reload();
    void reloadPromise.finally(() => {
      if (pendingProtectionTicket.current === ticket) pendingProtectionTicket.current = undefined;
    });
  };

  const closeProtectionReview = () => {
    cancelProtectionPreview();
    pendingProtectionTicket.current = undefined;
    setProtectionReview(undefined);
    setProtectionReviewLoading(false);
    setProtectionReviewError("");
    setProtectionReviewNotice("");
    requestAnimationFrame(() => composerRef.current?.focusEnd());
  };

  const toggleThreadTrace = () => {
    if (!admin || !traceCapture.loaded) return;
    if (!traceCapture.rawBodies) {
      setAdminOpen(true);
      return;
    }
    setThreadTraceError(false);
    const persistedThreadId = activeThreadId;
    const next = !threadTraceEnabled;
    setThreadTraceEnabledState(next);
    if (!persistedThreadId) return;
    queryClient.setQueryData<ThreadSummary[]>(threadKeys.all, (current) =>
      current?.map((thread) => (thread.id === persistedThreadId ? { ...thread, traceEnabled: next } : thread)),
    );
    void setThreadTraceEnabled({ data: { threadId: persistedThreadId, traceEnabled: next } })
      .then(() => invalidateThreads(queryClient))
      .catch((err) => {
        console.warn("Failed to update thread trace capture", err);
        setThreadTraceError(true);
        setThreadTraceEnabledState(!next);
        queryClient.setQueryData<ThreadSummary[]>(threadKeys.all, (current) =>
          current?.map((thread) => (thread.id === persistedThreadId ? { ...thread, traceEnabled: !next } : thread)),
        );
      });
  };

  // Suggestions prime the composer instead of sending: the copy references a document the user still needs
  // to paste or attach, so firing a send here would dead-end on empty context.
  const pickSuggestion = (prompt: string) => {
    setInput((current) => draftWithSuggestion(current, prompt));
    requestAnimationFrame(() => composerRef.current?.focusEnd());
  };

  const handleFilesSelected = async (files: File[]) => {
    requestAnimationFrame(() => composerRef.current?.focus());

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
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const resetChat = () => {
    // Guard an unsent draft: starting a new chat below discards the composer, so confirm first rather
    // than silently dropping typed text or staged attachments.
    const hasDraft = input.trim().length > 0 || attachments.length > 0;
    if (hasDraft && !window.confirm("Discard your unsent message and start a new chat?")) return;
    cancelProtectionPreview();
    pendingProtectionTicket.current = undefined;

    // Start a genuinely new thread: navigate to `/`, which mounts a fresh ChatView with a new thread id.
    // (clear() alone would reuse this id and overwrite the current thread, and the URL may already be
    // synced to /chat/<id> from persist().) A hard assign guarantees a clean remount.
    if (threadId || messages.length > 0) {
      window.location.assign("/");
      return;
    }
    clear();
    clearRestoreHighlightDisplay(queryClient, tid);
    setInput("");
    setAttachments([]);
    setUploadWarning(undefined);
    setProtectionReview(undefined);
    setProtectionReviewError("");
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const regenerate = () => {
    const latestUserText = latestUserMessageText(messagesRef.current);
    if (reviewBeforeSendEnabled && latestUserText) {
      void beginProtectionReview(latestUserText, "reload");
      return;
    }
    const assistantPosition = latestAssistantPosition(messagesRef.current);
    if (assistantPosition !== -1) clearRestoreHighlightsAtPosition(assistantPosition);
    void reload();
  };

  const reasoningLabel = REASONING_EFFORTS.find((effort) => effort.value === reasoningEffort)?.label;
  const reviewModelSummary = `${model.label} · ${model.sublabel}${model.reasoningEfforts.length > 0 && reasoningLabel ? ` · ${reasoningLabel} reasoning` : ""}`;
  const reviewContent = protectionReview ? (
    <ProtectionReview
      text={protectionReview.text}
      preview={protectionReview.preview}
      busy={protectionReviewLoading}
      error={protectionReviewError || undefined}
      notice={protectionReviewNotice || undefined}
      onBack={closeProtectionReview}
      onProtect={protectSelection}
      onRemove={removeChatProtection}
      onSend={sendProtected}
      onSuggest={suggestForWorkspace}
      suggestValues={protectionReview.newlyProtectedValues}
      modelSummary={reviewModelSummary}
    />
  ) : protectionReviewLoading ? (
    <ProtectionReviewLoading onBack={closeProtectionReview} />
  ) : undefined;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-dvh overflow-hidden bg-background text-foreground">
        <ChatSidebar
          open={sidebar.open}
          onToggle={sidebar.toggle}
          onClose={sidebar.close}
          onNewChat={resetChat}
          onOpenAdmin={() => setAdminOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onCreateWorkspace={() => setCreateWorkspaceOpen(true)}
          activeThreadId={activeThreadId}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            sidebarOpen={sidebar.open}
            onToggleSidebar={sidebar.toggle}
            protectionStatus={protectionStatus}
            threadTraceEnabled={threadTraceEnabled}
            threadTraceControlVisible={admin}
            threadTraceControlDisabled={!traceCapture.loaded || !traceCapture.rawBodies}
            threadTraceControlLoading={!traceCapture.loaded}
            threadTraceError={threadTraceError}
            traceAuditEnabled={traceCapture.traceAudit}
            onToggleThreadTrace={toggleThreadTrace}
            reviewBeforeSend={reviewBeforeSendEnabled}
            reviewBeforeSendRequired={protectionReviewRequired}
            onToggleReviewBeforeSend={() => {
              if (!protectionReviewRequired) setReviewBeforeSend((enabled) => !enabled);
            }}
            restoreDisplayMode={restoreDisplayMode}
            restoreHighlightsAvailable={restoreHighlightsAvailable}
            onToggleRestoreDisplay={() =>
              setRestoreDisplayMode((mode) => (mode === "values" ? "surrogates" : "values"))
            }
            onOpenEvidence={() => setEvidenceOpen(true)}
          />

          <MessageList
            messages={displayMessages}
            isLoading={isLoading}
            onRegenerate={regenerate}
            onPickSuggestion={pickSuggestion}
            restoreDisplayMode={restoreDisplayMode}
            protectionStatus={protectionStatus}
          />

          {error ? (
            <div className="pb-2">
              <ErrorBanner message={error.message} onRetry={isLoading ? undefined : regenerate} />
            </div>
          ) : null}

          {saveWarning ? <SaveWarningNotice onDismiss={() => setSaveWarning(false)} /> : null}

          <ProtectionNotice status={protectionStatus} />

          {protectionReviewError && !reviewContent ? (
            <div className="pb-2">
              <ErrorBanner message={protectionReviewError} onRetry={() => void beginProtectionReview(input)} />
            </div>
          ) : null}
          <Composer
            ref={composerRef}
            value={input}
            onChange={(value) => {
              setInput(value);
              setProtectionReviewError("");
            }}
            onSubmit={() => send(input)}
            onStop={stop}
            isLoading={isLoading}
            isExtracting={isExtracting}
            disabledReason={posture.kind === "blocked" ? posture.reason : undefined}
            model={model}
            onModelChange={chooseModel}
            reasoningEffort={reasoningEffort}
            onReasoningEffortChange={setReasoningEffort}
            defaultModel={userSettings?.defaultModel}
            defaultReasoningEffort={userSettings?.defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT}
            attachments={attachments}
            uploadWarning={uploadWarning}
            autoFocus={!threadId && messages.length === 0}
            onFilesSelected={handleFilesSelected}
            onRemoveAttachment={(id) =>
              setAttachments((current) => current.filter((attachment) => attachment.id !== id))
            }
            onDismissUploadWarning={() => setUploadWarning(undefined)}
            review={reviewContent}
          />
        </div>

        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} userSettings={userSettings} />
        <AdminSettingsDialog open={adminOpen} onOpenChange={setAdminOpen} />
        <CreateWorkspaceDialog open={createWorkspaceOpen} onOpenChange={setCreateWorkspaceOpen} />
        <ThreadEvidenceDialog open={evidenceOpen} onOpenChange={setEvidenceOpen} threadId={tid} />

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

function SaveWarningNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="pb-2">
      <div className="mx-auto w-full max-w-3xl px-4">
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1">
            This chat isn&apos;t being saved to your history right now. Your conversation is still here.
          </p>
          <button
            type="button"
            className="rounded-md p-0.5 text-amber-900/70 hover:bg-amber-100 hover:text-amber-950 focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:p-2 dark:text-amber-100/70 dark:hover:bg-amber-900/40 dark:hover:text-amber-50"
            onClick={onDismiss}
            aria-label="Dismiss save warning"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>
    </div>
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
  const registryBlock = requiredRegistryBlock(status);
  if (registryBlock) return { kind: "blocked", reason: registryBlock.message };
  if (status.pii.status === "blocking") {
    return { kind: "blocked", reason: "Chat is paused until ficta protection recovers." };
  }
  if (!status.protection.protecting) return { kind: "passthrough" };
  return { kind: "ok" };
}

function userMessage(content: string, annotations: readonly ProtectionHighlightAnnotation[] = []): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [withProtectionAnnotations({ type: "text" as const, content }, annotations)],
    createdAt: new Date(),
  };
}

function replaceLatestUserProtectionAnnotations(
  messages: UIMessage[],
  annotations: readonly ProtectionHighlightAnnotation[],
): UIMessage[] {
  const position = latestMessagePosition(messages, "user");
  if (position === -1) return messages;
  return messages.map((message, messagePosition) => {
    if (messagePosition !== position) return message;
    let applied = false;
    const parts = message.parts.map((part) => {
      if (applied || part.type !== "text") return part;
      applied = true;
      return withProtectionAnnotations(part, annotations);
    });
    return applied ? { ...message, parts } : message;
  });
}

function latestAssistantPosition(messages: UIMessage[]): number {
  return latestMessagePosition(messages, "assistant");
}

function latestMessagePosition(messages: UIMessage[], role: UIMessage["role"]): number {
  for (let position = messages.length - 1; position >= 0; position -= 1) {
    if (messages[position]?.role === role) return position;
  }
  return -1;
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
    traceEnabled: existing?.traceEnabled ?? false,
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
  return deriveThreadTitleFromText(text);
}

function latestUserMessageText(messages: UIMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.content)
      .join("");
    return text || undefined;
  }
  return undefined;
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
