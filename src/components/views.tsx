"use client";

import { useEffect, useState } from "react";
import type { Conversation, RuntimeTask, WorkspaceStats } from "@/lib/types";
import { cn, formatBytes, timeAgo } from "@/lib/utils";
import { workspaceStats } from "@/storage";
import { StatusChip } from "./agent-ui";
import { Icon, Logo } from "./icons";
import { WorkspaceMedia } from "./media";
import { MemoryView } from "./memory";

/* ---------------- toasts ---------------- */

interface ToastItem {
  id: string;
  message: string;
  kind: "info" | "ok" | "danger";
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const onToast = (event: Event) => {
      const detail = (event as CustomEvent<ToastItem>).detail;
      setItems((prev) => [...prev.slice(-2), detail]);
      setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== detail.id));
      }, 2600);
    };
    window.addEventListener("aether:toast", onToast);
    return () => window.removeEventListener("aether:toast", onToast);
  }, []);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[70] flex flex-col items-center gap-2 px-4 sm:bottom-6">
      {items.map((item) => (
        <div
          key={item.id}
          className={cn(
            "anim-pop pointer-events-auto flex items-center gap-2 rounded-lg border px-3.5 py-2 text-[13px] shadow-xl shadow-black/40 backdrop-blur-sm",
            item.kind === "ok" && "border-ok-400/25 bg-ink-800 text-ok-400",
            item.kind === "danger" && "border-danger-400/25 bg-ink-800 text-danger-400",
            item.kind === "info" && "border-line-strong bg-ink-800 text-fog-200",
          )}
        >
          <Icon name={item.kind === "ok" ? "check" : item.kind === "danger" ? "alert" : "sparkle"} size={13} />
          {item.message}
        </div>
      ))}
    </div>
  );
}

/* ---------------- offline banner ---------------- */

export function OfflineBanner() {
  return (
    <div className="flex items-center justify-center gap-2 border-b border-warn-400/20 bg-warn-400/10 px-4 py-1.5 text-[12px] text-warn-400">
      <Icon name="wifiOff" size={12.5} />
      Offline — everything still saves locally, and responses come from the on-device mock.
    </div>
  );
}

/* ---------------- skeletons ---------------- */

export function MessagesSkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
      <div className="ml-auto h-14 w-2/3 rounded-2xl bg-ink-750" />
      <div className="space-y-2.5">
        <div className="skeleton h-4 w-11/12" />
        <div className="skeleton h-4 w-3/4" />
        <div className="skeleton h-4 w-2/3" />
      </div>
      <div className="ml-auto h-10 w-1/2 rounded-2xl bg-ink-750" />
      <div className="space-y-2.5">
        <div className="skeleton h-4 w-10/12" />
        <div className="skeleton h-4 w-5/12" />
      </div>
    </div>
  );
}

/* ---------------- empty state ---------------- */

const SUGGESTIONS = [
  { icon: "image" as const, label: "Generate artwork", hint: "Render a high-quality image", text: "/task Draw a high-quality abstract aurora artwork in warm ember tones." },
  { icon: "list" as const, label: "Run an agent task", hint: "Plan, execute and validate steps", text: "/task Search the workspace for earlier notes about storage and summarize what you find." },
  { icon: "terminal" as const, label: "Write & run code", hint: "Sandboxed real execution", text: "Write a Node script that prints the first 10 Fibonacci numbers and run it" },
  { icon: "globe" as const, label: "Search & fetch the web", hint: "Sources with citations", text: "Search the web for the latest news about transformer inference and summarize it" },
];

export function EmptyState({ onSuggest }: { onSuggest: (text: string) => void }) {
  return (
    /* Scroll-safe: on short/phone screens the content scrolls inside the
       message area instead of overflowing under the composer. */
    <div data-testid="empty-state" className="h-full min-h-0 w-full overflow-y-auto">
      <div className="anim-rise mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center px-5 py-8 text-center sm:px-6 sm:py-12">
        {/* Orbital mark — counter-rotating rings, ember core, breathing glow. */}
        <div className="relative mb-5 flex size-16 items-center justify-center sm:mb-7 sm:size-20">
          <div className="anim-glow absolute inset-0 rounded-full bg-ember-400/10 blur-2xl" />
          <svg viewBox="0 0 80 80" className="anim-orbit absolute inset-0 h-full w-full text-ember-400/45" fill="none" aria-hidden="true">
            <ellipse cx="40" cy="40" rx="34" ry="13" stroke="currentColor" strokeWidth="1.1" transform="rotate(-24 40 40)" />
          </svg>
          <svg viewBox="0 0 80 80" className="anim-orbit-rev absolute inset-0 h-full w-full text-fog-500/30" fill="none" aria-hidden="true">
            <ellipse cx="40" cy="40" rx="27" ry="10" stroke="currentColor" strokeWidth="1" transform="rotate(32 40 40)" />
          </svg>
          <div className="relative flex size-10 items-center justify-center rounded-xl border border-ember-400/35 bg-ink-800 text-ember-400 shadow-[0_0_38px_-8px_rgba(226,177,97,0.5),inset_0_1px_0_rgba(255,255,255,0.06)] sm:size-11">
            <Logo size={22} />
          </div>
        </div>

        <h1 className="max-w-[22ch] font-display text-[24px] font-semibold leading-[1.18] tracking-[-0.02em] text-fog-100 sm:text-3xl md:text-4xl">
          What should we build today?
        </h1>
        <p className="mt-2.5 max-w-[36ch] text-[13px] leading-relaxed text-fog-400 sm:mt-3 sm:max-w-md sm:text-sm">
          Aether pairs this workspace with a two-engine GPU fleet — it plans, executes commands,
          searches the web and renders media. Everything stays on this device.
        </p>

        <div className="mt-6 grid w-full max-w-lg grid-cols-1 gap-2 sm:mt-9 sm:grid-cols-2 sm:gap-2.5">
          {SUGGESTIONS.map((item, index) => (
            <button
              key={item.label}
              type="button"
              onClick={() => onSuggest(item.text)}
              style={{ animationDelay: `${120 + index * 60}ms` }}
              className="anim-rise group relative overflow-hidden rounded-xl border border-line bg-ink-850 px-3.5 py-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-ember-400/30 hover:bg-ink-800 hover:shadow-[0_10px_28px_-14px_rgba(226,177,97,0.35)] sm:px-4 sm:py-3.5"
            >
              <span className="absolute inset-y-0 left-0 w-px bg-ember-400/0 transition-colors duration-200 group-hover:bg-ember-400/70" />
              <span className="flex items-center gap-2.5 sm:mb-1.5 sm:block">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-ink-800 text-fog-500 transition-colors group-hover:border-ember-400/30 group-hover:text-ember-400 sm:mb-0 sm:size-auto sm:border-0 sm:bg-transparent sm:p-0">
                  <Icon name={item.icon} size={15} />
                </span>
                <span className="min-w-0 flex-1 sm:block">
                  <span className="block truncate text-[13.5px] font-medium text-fog-200 transition-colors group-hover:text-fog-100">
                    {item.label}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-fog-600 transition-colors group-hover:text-fog-500">
                    {item.hint}
                  </span>
                </span>
              </span>
            </button>
          ))}
        </div>

        <p className="mt-6 text-[11px] text-fog-600 sm:mt-8">
          <kbd className="rounded border border-line bg-ink-850 px-1 py-px font-mono text-[10px]">/task</kbd>{" "}
          launches multi-step agent runs · media and files stay in this browser
        </p>
      </div>
    </div>
  );
}

/* ---------------- error state ---------------- */

export function ErrorState({ title, detail, onRetry }: { title: string; detail?: string; onRetry: () => void }) {
  return (
    <div className="anim-rise flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl border border-danger-400/25 bg-danger-400/10 text-danger-400">
        <Icon name="alert" size={20} />
      </div>
      <h2 className="font-display text-lg font-semibold text-fog-100">{title}</h2>
      {detail ? <p className="max-w-sm text-[13px] leading-relaxed text-fog-400">{detail}</p> : null}
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 flex items-center gap-2 rounded-lg border border-line-strong bg-ink-800 px-4 py-2 text-[13px] font-medium text-fog-200 transition-colors hover:bg-ink-750"
      >
        <Icon name="refresh" size={14} />
        Try again
      </button>
    </div>
  );
}

/* ---------------- workspace home ---------------- */

export function WorkspaceHome({
  statsVersion,
  recent,
  tasks,
  onOpen,
  onNewChat,
  onOpenTask,
}: {
  statsVersion: number;
  recent: Conversation[];
  tasks: RuntimeTask[];
  onOpen: (id: string) => void;
  onNewChat: () => void;
  onOpenTask: (task: RuntimeTask) => void;
}) {
  const [stats, setStats] = useState<WorkspaceStats | null>(null);
  const [tab, setTab] = useState<"overview" | "memory" | "media">("overview");

  useEffect(() => {
    let cancelled = false;
    workspaceStats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {
        if (!cancelled) setStats({ conversations: 0, messages: 0, files: 0, bytes: 0, assets: 0, mediaBytes: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [statsVersion]);

  const cards = [
    { label: "Conversations", value: stats ? String(stats.conversations) : "—" },
    { label: "Messages", value: stats ? String(stats.messages) : "—" },
    { label: "Files stored", value: stats ? String(stats.files) : "—" },
    { label: "Media assets", value: stats ? `${stats.assets} · ${formatBytes(stats.mediaBytes)}` : "—" },
    { label: "Local storage", value: stats ? formatBytes(stats.bytes + stats.mediaBytes) : "—" },
  ];

  return (
    <div className="anim-rise mx-auto w-full max-w-3xl px-5 py-8 sm:py-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-fog-100">Workspace</h1>
          <p className="mt-1 text-[13px] text-fog-400">
            Everything below lives in this browser&apos;s IndexedDB — nothing leaves the device.
          </p>
        </div>
        <button
          type="button"
          onClick={onNewChat}
          className="hidden shrink-0 items-center gap-2 rounded-lg bg-ember-400 px-3.5 py-2 text-[13px] font-semibold text-ink-950 transition-colors hover:bg-ember-300 sm:flex"
        >
          <Icon name="plus" size={14} strokeWidth={2.2} />
          New chat
        </button>
      </div>

      {/* tabs */}
      <div className="mt-5 flex gap-1 rounded-xl border border-line bg-ink-850 p-1">
        {(
          [
            { id: "overview" as const, label: "Overview", icon: "grid" as const },
            { id: "media" as const, label: "Media", icon: "image" as const },
            { id: "memory" as const, label: "Memory", icon: "brain" as const },
          ]
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
              tab === item.id ? "bg-ink-700 text-fog-100" : "text-fog-500 hover:text-fog-300",
            )}
          >
            <Icon name={item.icon} size={14} className={tab === item.id ? "text-ember-400" : undefined} />
            {item.label}
          </button>
        ))}
      </div>

      {tab === "memory" ? (
        <div className="mt-5">
          <MemoryView refreshKey={statsVersion} />
        </div>
      ) : tab === "media" ? (
        <div className="mt-5">
          <WorkspaceMedia refreshKey={statsVersion} />
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
            {cards.map((card) => (
              <div key={card.label} className="rounded-xl border border-line bg-ink-850 px-4 py-3.5">
                <div className="font-display text-xl font-semibold text-fog-100">{card.value}</div>
                <div className="mt-0.5 text-[12px] text-fog-500">{card.label}</div>
              </div>
            ))}
          </div>

          <h2 className="mt-8 mb-2.5 text-[12px] font-semibold uppercase tracking-wide text-fog-500">Agent tasks</h2>
          {tasks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line-strong px-5 py-6 text-center text-[13px] text-fog-500">
              No agent runs yet — start one with{" "}
              <span className="font-mono text-ember-300">/task</span> followed by a goal.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-line bg-ink-850">
              {tasks.slice(0, 5).map((task, i) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => onOpenTask(task)}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-800",
                    i > 0 && "border-t border-line",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] text-fog-200">{task.goal}</span>
                  <StatusChip status={task.status} />
                  <span className="w-14 shrink-0 text-right text-[12px] text-fog-500">{timeAgo(task.updatedAt)}</span>
                </button>
              ))}
            </div>
          )}

          <h2 className="mt-8 mb-2.5 text-[12px] font-semibold uppercase tracking-wide text-fog-500">
            Recent conversations
          </h2>
          {recent.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line-strong px-5 py-8 text-center text-[13px] text-fog-500">
              No conversations yet — start one and it will appear here.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-line bg-ink-850">
              {recent.map((conversation, i) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => onOpen(conversation.id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-800",
                    i > 0 && "border-t border-line",
                  )}
                >
                  <span className="truncate text-[13.5px] text-fog-200">{conversation.title}</span>
                  <span className="shrink-0 text-[12px] text-fog-500">{timeAgo(conversation.updatedAt)}</span>
                </button>
              ))}
            </div>
          )}

          <div className="mt-8 flex items-start gap-3 rounded-xl border border-line bg-ink-850/60 px-4 py-3.5">
            <Icon name="terminal" size={15} className="mt-0.5 shrink-0 text-ember-400" />
            <p className="text-[12.5px] leading-relaxed text-fog-500">
              <span className="font-medium text-fog-400">Agent runtime, live.</span> Tasks plan, execute real
              sandboxed tools, pause for approvals and validate results — with memory and long-context summaries
              feeding every run. The remote model plugs into the same protocol whenever it&apos;s ready.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
