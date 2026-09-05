"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentMeta, Conversation, Message, RuntimeTask } from "@/lib/types";
import { cn, copyText, formatBytes, toast } from "@/lib/utils";
import { AssetStore } from "@/storage/AssetStore";
import { FileStore } from "@/storage";
import { engineOff, engineWake, useEngineStatus } from "@/lib/engine-client";
import { RuntimeEventView } from "./agent-ui";
import { Icon, Logo } from "./icons";
import { Markdown } from "./markdown";
import { openLightbox } from "./media";

/* ---------------- header ---------------- */

export function ChatHeader({
  conversation,
  view,
  online,
  tasksActive,
  onRename,
  onMenu,
  onOpenTasks,
}: {
  conversation: Conversation | null;
  view: "chat" | "workspace";
  online: boolean;
  tasksActive: boolean;
  onRename: (id: string, title: string) => void;
  onMenu: () => void;
  onOpenTasks: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const engineStatus = useEngineStatus(online);
  const [powerBusy, setPowerBusy] = useState(false);
  /* Wake-in-progress. Persists for the full boot (~10 min) — driven by the
   * server's wake-in-flight tracking, not a short local timer. The previous
   * 6-second auto-clear made the button look stuck: it reverted to "Engine
   * off" while the engine was still booting. */
  const [wakeRequested, setWakeRequested] = useState(false);

  /* ACTUALLY-LIVE engine state — confirmed by /api/ps, never a stale beacon.
   * `waking` comes from the server, which tracks both dispatched wake pushes
   * and Kaggle kernel boot status. */
  const engineState = engineStatus?.state ?? (engineStatus?.alive ? "live" : "offline");
  const serverSaysWaking = engineStatus?.waking ?? false;
  const engineLive = engineState === "live";
  /* Stay in "Waking…" while the server says waking OR we just dispatched and
   * haven't heard back yet. Once live, it's not waking regardless of the flag. */
  const engineWaking = !engineLive && (serverSaysWaking || wakeRequested);

  /* Once the engine is live, the wake flag is irrelevant — derived below. */
  /* Safety ceiling: never show "Waking…" for more than 16 minutes. */
  useEffect(() => {
    if (!wakeRequested) return;
    const timer = setTimeout(() => setWakeRequested(false), 16 * 60_000);
    return () => clearTimeout(timer);
  }, [wakeRequested]);

  /**
   * Power control. Waking is deliberately NON-BLOCKING: a real boot takes
   * several minutes, so awaiting it would freeze the button forever (the
   * original "infinite spinner" bug). Instead we fire the wake in the
   * background, show brief feedback, and let the polled engine status
   * (waking → live) drive the indicator. Every request has a hard timeout.
   */
  const togglePower = () => {
    if (powerBusy) return;

    if (engineLive) {
      /* Shutting down is fast — safe to await with a bounded timeout. */
      setPowerBusy(true);
      void engineOff()
        .then((result) => {
          const anyShutdown = result.killed?.some((k) => k.result === "shutdown");
          toast(result.message ?? (anyShutdown ? "Engines shut down." : "No running engines."), anyShutdown ? "ok" : "info");
        })
        .catch(() => toast("Engine power action failed.", "danger"))
        .finally(() => setPowerBusy(false));
      return;
    }

    /* Waking: fire-and-observe. Never block the UI on a multi-minute boot.
     * Keep wakeRequested set while the boot is in progress — the server's
     * status endpoint reports `waking: true` once the push is dispatched,
     * which drives the indicator until /api/ps confirms live. */
    setWakeRequested(true);
    toast("Waking engine — this takes about 10 minutes. The status indicator will update when it's live.", "info");
    void engineWake()
      .then((result) => {
        if (result.status === "alive") {
          setWakeRequested(false);
          toast(`Engine is live${result.url ? ` — ${result.url}` : ""}`, "ok");
        } else if (result.status === "waking") {
          /* Keep the wake flag set — the boot is in progress. The polled
           * engine status will flip to "live" when /api/ps responds. */
          toast(`Wake dispatched (${result.reason ?? "boot in progress"}). Booting…`, "info");
        } else {
          setWakeRequested(false);
          toast(result.message ?? "Engine could not be woken.", "danger");
        }
      })
      .catch(() => {
        /* Keep wakeRequested: the push may have been dispatched even if the
         * response timed out. The status poll will confirm either way. */
        toast("Wake request still in progress — the engine may still be booting.", "info");
      });
  };

  const commit = () => {
    setEditing(false);
    if (conversation && draft.trim()) onRename(conversation.id, draft);
  };

  return (
    <header className="flex h-[54px] shrink-0 items-center gap-2.5 border-b border-line bg-ink-900/95 px-3 backdrop-blur-sm sm:px-5">
      <button
        type="button"
        onClick={onMenu}
        className="rounded-lg p-2 text-fog-400 transition-colors hover:bg-ink-800 hover:text-fog-100 lg:hidden"
        aria-label="Open menu"
      >
        <Icon name="menu" size={17} />
      </button>

      <div className="min-w-0 flex-1">
        {view === "workspace" ? (
          <span className="font-display text-[15px] font-semibold tracking-tight text-fog-100">Workspace</span>
        ) : conversation ? (
          editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(false);
              }}
              className="w-full max-w-md rounded-lg border border-line-strong bg-ink-800 px-2.5 py-1.5 text-[13.5px] text-fog-100 focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraft(conversation.title);
                setEditing(true);
              }}
              className="group flex min-w-0 items-center gap-2 text-left"
              title="Rename conversation"
            >
              <span className="truncate text-[14.5px] font-medium text-fog-100">{conversation.title}</span>
              <Icon name="pencil" size={11.5} className="shrink-0 text-fog-600 opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          )
        ) : (
          <span className="text-[14.5px] font-medium text-fog-300">New conversation</span>
        )}
      </div>

      <button
        type="button"
        onClick={onOpenTasks}
        className="relative shrink-0 rounded-lg p-2 text-fog-400 transition-colors hover:bg-ink-800 hover:text-fog-100"
        aria-label="Agent tasks"
        title="Agent tasks"
      >
        <Icon name="terminal" size={15.5} />
        {tasksActive ? <span className="anim-pulse absolute right-1 top-1 size-1.5 rounded-full bg-ember-400" /> : null}
      </button>

      {/* Engine power control: shows the ACTUALLY-LIVE engine state (confirmed
          by /api/ps) — never a stale beacon read. Click to wake / shut down. */}
      <button
        type="button"
        onClick={togglePower}
        disabled={powerBusy || !online}
        title={
          engineLive
            ? "Engine is live — click to shut down"
            : engineWaking
              ? "Engine is waking up…"
              : "Engine is off — click to wake"
        }
        aria-label={engineLive ? "Shut down engine" : engineWaking ? "Engine waking" : "Wake engine"}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
          !online && "cursor-not-allowed border-line bg-ink-850 text-fog-600",
          online && engineLive && "border-ok-400/30 bg-ok-400/10 text-ok-400 hover:bg-ok-400/20",
          online && engineWaking && "border-ember-400/30 bg-ember-400/10 text-ember-300",
          online && !engineLive && !engineWaking && !powerBusy && "border-line bg-ink-850 text-fog-400 hover:border-line-strong hover:text-fog-200",
          online && powerBusy && "border-ember-400/30 bg-ember-400/10 text-ember-300",
        )}
      >
        {powerBusy || engineWaking ? (
          <Icon name="refresh" size={11} className="animate-spin" />
        ) : (
          <span
            className={cn(
              "size-1.5 rounded-full",
              !online ? "bg-fog-600" : engineLive ? "bg-ok-400" : engineWaking ? "anim-pulse bg-ember-400" : "bg-fog-500",
            )}
          />
        )}
        <span className="hidden sm:inline">
          {!online
            ? "Offline"
            : powerBusy
              ? "Working…"
              : engineLive
                ? "Engine live"
                : engineWaking
                  ? "Waking…"
                  : "Engine off"}
        </span>
        <span className="sm:hidden">
          {!online ? "Off" : powerBusy ? "…" : engineLive ? "Live" : engineWaking ? "…" : "Off"}
        </span>
      </button>
    </header>
  );
}

/* ---------------- attachments ---------------- */

function AttachmentView({ attachment }: { attachment: AttachmentMeta }) {
  const [storedUrl, setStoredUrl] = useState<string | null>(null);
  const [assetKind, setAssetKind] = useState<"image" | "video" | "audio" | null>(null);

  /* Workspace media assets resolve through the AssetStore. */
  useEffect(() => {
    if (!attachment.assetId) return;
    let cancelled = false;
    AssetStore.get(attachment.assetId).then(async (record) => {
      if (cancelled || !record) return;
      setAssetKind(record.kind);
      const resolved = await AssetStore.urlFor(attachment.assetId as string);
      if (!cancelled) setStoredUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [attachment.assetId]);

  /* Server artifacts carry a direct URL; local blobs resolve via FileStore. */
  useEffect(() => {
    if (attachment.url || attachment.assetId) return;
    let cancelled = false;
    FileStore.urlFor(attachment.id).then((resolved) => {
      if (!cancelled) setStoredUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [attachment.id, attachment.url, attachment.assetId]);

  const url = attachment.url ?? storedUrl;

  /* Workspace media: inline players for video/audio, lightbox for images,
   * with download buttons on all media types. */
  if (attachment.assetId) {
    const kind = assetKind ?? (attachment.mimeType.startsWith("image/") ? "image" : attachment.mimeType.startsWith("video/") ? "video" : attachment.mimeType.startsWith("audio/") ? "audio" : null);
    if (!url) return <div className="skeleton h-24 w-40" />;
    if (kind === "video") {
      return (
        <div>
          <video src={url} controls className="max-h-56 max-w-full rounded-lg border border-line" />
          <div className="mt-1"><a href={url} download={attachment.name} className="text-[11px] text-fog-500 underline hover:text-fog-300">Download</a></div>
        </div>
      );
    }
    if (kind === "audio") {
      return (
        <span className="block w-[260px] rounded-lg border border-line bg-ink-750 px-2.5 py-2">
          <span className="mb-1 flex items-center gap-1.5 text-[10.5px] uppercase tracking-wide text-fog-500">
            {attachment.name}
          </span>
          <audio src={url} controls className="block h-9 w-full" />
          <a href={url} download={attachment.name} className="mt-1 block text-[11px] text-fog-500 underline hover:text-fog-300">Download</a>
        </span>
      );
    }
    return (
      <div>
        <button type="button" onClick={() => openLightbox(attachment.assetId as string)} className="block" aria-label={`Open ${attachment.name}`}>
          <img src={url} alt={attachment.name} className="max-h-56 w-auto max-w-full cursor-zoom-in rounded-lg border border-line object-contain" />
        </button>
        <a href={url} download={attachment.name} className="mt-1 block text-[11px] text-fog-500 underline hover:text-fog-300">Download</a>
      </div>
    );
  }

  if (attachment.kind === "image") {
    return url ? (
      <div>
        <img
          src={url}
          alt={attachment.name}
          className="max-h-56 w-auto max-w-full rounded-lg border border-line object-contain"
        />
        <a href={url} download={attachment.name} className="mt-1 block text-[11px] text-fog-500 underline hover:text-fog-300">Download</a>
      </div>
    ) : (
      <div className="skeleton h-24 w-40" />
    );
  }

  /* Inline players for locally-attached video/audio. */
  if (attachment.kind === "video") {
    return url ? (
      <video src={url} controls className="max-h-56 max-w-full rounded-lg border border-line" />
    ) : (
      <div className="skeleton h-24 w-40" />
    );
  }
  if (attachment.kind === "audio") {
    return url ? (
      <span className="block w-[260px] rounded-lg border border-line bg-ink-750 px-2.5 py-2">
        <span className="mb-1 flex items-center gap-1.5 text-[10.5px] uppercase tracking-wide text-fog-500">
          {attachment.name}
        </span>
        <audio src={url} controls className="block h-9 w-full" />
        <a href={url} download={attachment.name} className="mt-1 block text-[11px] text-fog-500 underline hover:text-fog-300">Download</a>
      </span>
    ) : (
      <div className="skeleton h-16 w-[260px]" />
    );
  }

  const inner = (
    <>
      <Icon name="file" size={13} className="shrink-0 text-fog-500" />
      <span className="truncate text-[12px] text-fog-300">{attachment.name}</span>
      <span className="shrink-0 text-[11px] text-fog-600">{formatBytes(attachment.size)}</span>
    </>
  );

  if (attachment.url) {
    return (
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex max-w-[240px] items-center gap-2 rounded-lg border border-line bg-ink-750 px-2.5 py-1.5 transition-colors hover:border-line-strong"
        title={`Open ${attachment.name}`}
      >
        {inner}
      </a>
    );
  }

  return <span className="flex max-w-[240px] items-center gap-2 rounded-lg border border-line bg-ink-750 px-2.5 py-1.5">{inner}</span>;
}

/* ---------------- tool events ---------------- */

function ToolEvents({ message }: { message: Message }) {
  if (!message.events || message.events.length === 0) return null;
  return (
    <div className="mb-2.5 space-y-1">
      {message.events.map((event) => (
        <div
          key={event.id}
          className={cn(
            "anim-rise flex items-center gap-2 rounded-lg border px-3 py-1.5",
            event.state === "error"
              ? "border-danger-400/25 bg-danger-400/[0.06]"
              : event.state === "running"
                ? "border-ember-400/25 bg-ember-400/[0.05]"
                : "border-line bg-ink-850",
          )}
        >
          {event.state === "running" ? (
            <Icon name="refresh" size={12} className="animate-spin text-ember-400" />
          ) : event.state === "error" ? (
            <Icon name="alert" size={12} className="text-danger-400" />
          ) : (
            <Icon name="check" size={12} className="text-ok-400" />
          )}
          <span className="font-mono text-[11.5px] text-fog-300">{event.name}</span>
          {event.detail ? <span className="truncate text-[11.5px] text-fog-500">{event.detail}</span> : null}
        </div>
      ))}
    </div>
  );
}

/* ---------------- messages ---------------- */

const MessageItem = memo(function MessageItem({
  message,
  isLast,
  streaming,
  onRetry,
  onApprove,
  liveTask,
}: {
  message: Message;
  isLast: boolean;
  streaming: boolean;
  onRetry: (id: string) => void;
  onApprove: (requestId: string, approved: boolean) => void;
  liveTask: RuntimeTask | null;
}) {
  if (message.role === "user") {
    return (
      <div className="anim-rise flex flex-col items-end">
        {message.attachments && message.attachments.length > 0 ? (
          <div className="mb-2 flex max-w-full flex-wrap justify-end gap-2">
            {message.attachments.map((attachment) => (
              <AttachmentView key={attachment.id} attachment={attachment} />
            ))}
          </div>
        ) : null}
        {message.content ? (
          <div className="max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-line-strong bg-gradient-to-b from-ink-700 to-ink-750 px-4 py-2.5 text-[14px] leading-relaxed text-fog-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_2px_10px_-4px_rgba(0,0,0,0.5)] sm:max-w-[78%]">
            {message.content}
          </div>
        ) : null}
      </div>
    );
  }

  const busy = isLast && streaming;
  const empty = message.content.length === 0;
  const hasRuntime = Boolean(message.runtime);
  const runtimeTask = hasRuntime && liveTask && liveTask.id === message.runtime?.taskId ? liveTask : null;

  return (
    <div className="anim-rise flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-ember-400/30 bg-ink-800 text-ember-400 shadow-[0_0_16px_-4px_rgba(226,177,97,0.35),inset_0_1px_0_rgba(255,255,255,0.05)]">
        <Logo size={15} />
      </div>
      <div className="min-w-0 flex-1">
        <ToolEvents message={message} />

        {message.runtime ? (
          <RuntimeEventView snapshot={message.runtime} active={busy} task={runtimeTask} onApprove={onApprove} />
        ) : null}

        {/* Model reasoning — collapsible "thinking" panel. */}
        {message.thinking ? <ThinkingPanel thinking={message.thinking} live={busy && empty} /> : null}

        {empty && busy && !hasRuntime ? (
          <div className="flex items-center gap-2 py-1.5 text-fog-400">
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 anim-pulse rounded-full bg-ember-400" />
              <span className="size-1.5 anim-pulse rounded-full bg-ember-400 [animation-delay:0.18s]" />
              <span className="size-1.5 anim-pulse rounded-full bg-ember-400 [animation-delay:0.36s]" />
            </span>
            {message.statusText ? <span className="text-[12px] text-fog-500">{message.statusText}</span> : null}
          </div>
        ) : empty && !hasRuntime ? null : (
          <div className={cn(busy && !empty && "stream-caret")}>
            <Markdown content={message.content} />
          </div>
        )}

        {/* Real-tool artifacts (screenshots, outputs) produced by the run. */}
        {message.attachments && message.attachments.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {message.attachments.map((attachment) => (
              <AttachmentView key={attachment.id} attachment={attachment} />
            ))}
          </div>
        ) : null}

        {message.status === "error" ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-3 rounded-lg border border-danger-400/25 bg-danger-400/10 px-3.5 py-2.5">
            <Icon name="alert" size={14} className="shrink-0 text-danger-400" />
            <span className="min-w-0 flex-1 text-[12.5px] text-danger-400">
              {message.error ?? "The agent request failed."}
            </span>
            <button
              type="button"
              onClick={() => onRetry(message.id)}
              className="flex items-center gap-1.5 rounded-md border border-danger-400/30 px-2.5 py-1 text-[12px] font-medium text-danger-400 transition-colors hover:bg-danger-400/15"
            >
              <Icon name="refresh" size={12} />
              Retry
            </button>
          </div>
        ) : null}

        {message.status === "stopped" ? (
          <p className="mt-2 text-[11.5px] italic text-fog-600">Generation stopped.</p>
        ) : null}

        {!busy && !empty && message.status !== "error" ? (
          <div className={cn("mt-1.5 flex items-center gap-1", isLast ? "opacity-100" : "opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100")}>
            <MessageAction
              icon="copy"
              label="Copy"
              onClick={async () => {
                if (await copyText(message.content)) toast("Copied to clipboard", "ok");
              }}
            />
            {isLast ? <MessageAction icon="refresh" label="Regenerate" onClick={() => onRetry(message.id)} /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

function MessageAction({ icon, label, onClick }: { icon: "copy" | "refresh"; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-md p-1.5 text-fog-600 transition-colors hover:bg-ink-800 hover:text-fog-300"
    >
      <Icon name={icon} size={13} />
    </button>
  );
}

/** Collapsible panel for the model's reasoning, with a "v" chevron. */
/**
 * Reasoning / tool-activity panel.
 * Renders the REAL streamed `message.thinking` events as they arrive — each
 * agent step or tool call appears the moment the engine emits it, with a
 * smooth entrance and auto-scroll to the newest line. Nothing is invented:
 * if the engine sends no thinking, no panel is shown.
 */
/**
 * Reasoning / execution log panel.
 * Renders the REAL streamed thinking events from the engine — cleaned of
 * decorative emojis by `cleanThinkingLine` — as a live, auto-scrolling
 * execution log. Each line appears the moment the engine emits it. Tool
 * calls get a subtle accent. No emojis, no fake animation loops.
 */
export function ThinkingPanel({ thinking, live }: { thinking: string; live?: boolean }) {
  const [open, setOpen] = useState(true);
  const [userToggled, setUserToggled] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lineCountRef = useRef(0);

  const lines = thinking.split("\n").filter((l) => l.trim().length > 0);

  const effectiveOpen = userToggled ? open : live ? true : open;

  /* Auto-scroll to the newest line as it streams in. */
  useEffect(() => {
    if (lines.length !== lineCountRef.current) {
      lineCountRef.current = lines.length;
      const el = scrollRef.current;
      if (el && effectiveOpen) el.scrollTop = el.scrollHeight;
    }
  }, [lines.length, effectiveOpen]);

  /* Detect tool-call and result lines for subtle accent styling. */
  const isToolCall = (line: string) => /^[a-z_]+\(/.test(line);
  const isToolResult = (line: string) => line.startsWith("→ ");

  const label = live
    ? `Thinking${lines.length > 0 ? ` · ${lines.length} steps` : ""}`
    : lines.length > 0
      ? `Thought process · ${lines.length} steps`
      : "Reasoning";

  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-line bg-ink-850/60" data-testid="thinking-panel">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setUserToggled(true);
        }}
        aria-expanded={effectiveOpen}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-fog-400 transition-colors hover:bg-ink-800 hover:text-fog-200"
      >
        <Icon name="chevronDown" size={13} className={cn("shrink-0 transition-transform duration-200", effectiveOpen ? "" : "-rotate-90")} />
        <span className="flex items-center gap-1.5">
          {live ? <span className="size-1.5 rounded-full bg-ember-400 transition-opacity" style={{ opacity: 1 }} /> : null}
          {label}
        </span>
        <span className="ml-auto font-mono text-[10px] font-normal text-fog-600">{effectiveOpen ? "hide" : "show"}</span>
      </button>
      {effectiveOpen ? (
        <div
          ref={scrollRef}
          className="max-h-48 overflow-y-auto border-t border-line px-3 py-2 font-mono text-[11.5px] leading-[1.75] text-fog-500"
        >
          {lines.map((line, i) => {
            const newest = i === lines.length - 1 && live;
            const toolCall = isToolCall(line);
            const toolResult = isToolResult(line);
            return (
              <div
                key={`${i}-${line.slice(0, 20)}`}
                className={cn(
                  "flex gap-2 whitespace-pre-wrap break-words",
                  i > 0 && "mt-0.5",
                  newest && "text-fog-200",
                  toolCall && !newest && "text-ember-300/90",
                  toolResult && !newest && "text-fog-400",
                )}
              >
                <span
                  className={cn(
                    "mt-[7px] size-1 shrink-0 rounded-full",
                    toolCall ? "bg-ember-400/70" : toolResult ? "bg-fog-600" : "bg-fog-700",
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">{line}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- message list ---------------- */

export function MessageList({
  messages,
  streaming,
  onRetry,
  conversationKey,
  onApprove,
  liveTask,
}: {
  messages: Message[];
  streaming: boolean;
  onRetry: (id: string) => void;
  conversationKey: string;
  onApprove: (requestId: string, approved: boolean) => void;
  liveTask: RuntimeTask | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  };

  useEffect(() => {
    stickRef.current = true;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversationKey]);

  useEffect(() => {
    const el = containerRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  /* Stable callbacks keep memoized rows from re-rendering during streaming. */
  const retryRef = useRef(onRetry);
  useEffect(() => {
    retryRef.current = onRetry;
  }, [onRetry]);
  const stableRetry = useCallback((id: string) => retryRef.current(id), []);

  return (
    <div ref={containerRef} onScroll={handleScroll} className="h-full overflow-y-auto scroll-smooth">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 pb-6 pt-6 sm:px-6 sm:pt-9">
        {messages.map((message, index) => (
          <MessageItem
            key={message.id}
            message={message}
            isLast={index === messages.length - 1}
            streaming={streaming}
            onRetry={stableRetry}
            onApprove={onApprove}
            liveTask={message.runtime && liveTask?.id === message.runtime.taskId ? liveTask : null}
          />
        ))}
      </div>
    </div>
  );
}
