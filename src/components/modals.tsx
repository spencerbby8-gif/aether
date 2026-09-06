"use client";

import { useEffect, useRef, useState } from "react";
import type { SearchResult, Settings } from "@/lib/types";
import { cn, timeAgo, toast } from "@/lib/utils";
import { engineOff, engineWake, useEngineSnapshot, type EngineSnapshot, type SlotHealth } from "@/lib/engine-client";
import { ConversationStore } from "@/storage";
import { Icon } from "./icons";

/* ---------------- shell ---------------- */

function Modal({
  onClose,
  children,
  wide,
}: {
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 cursor-default bg-ink-950/70 backdrop-blur-[2px]" />
      <div
        className={cn(
          "anim-pop relative w-full overflow-hidden rounded-2xl border border-line-strong bg-ink-850 shadow-2xl shadow-black/60",
          wide ? "max-w-xl" : "max-w-md",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/* ---------------- search ---------------- */

export function SearchModal({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (conversationId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => {
      if (!query.trim()) {
        setResults([]);
        setSearching(false);
        return;
      }
      setSearching(true);
      ConversationStore.search(query)
        .then((found) => {
          setResults(found);
          setIndex(0);
        })
        .finally(() => setSearching(false));
    }, 140);
    return () => clearTimeout(handle);
  }, [query]);

  const select = (conversationId: string) => {
    onOpen(conversationId);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter" && results[index]) {
      select(results[index].conversation.id);
    }
  };

  return (
    <Modal onClose={onClose} wide>
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <Icon name="search" size={15} className="shrink-0 text-fog-500" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search conversations and messages…"
          className="h-12 flex-1 bg-transparent text-[14px] text-fog-100 placeholder:text-fog-600 focus:outline-none"
        />
        <kbd className="rounded border border-line-strong bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-fog-500">esc</kbd>
      </div>

      <div className="max-h-[46vh] overflow-y-auto p-2">
        {!query.trim() ? (
          <p className="px-3 py-6 text-center text-[13px] text-fog-500">
            Type to search titles and message contents.
          </p>
        ) : searching ? (
          <div className="space-y-2 p-2">
            <div className="skeleton h-10" />
            <div className="skeleton h-10 w-4/5" />
          </div>
        ) : results.length === 0 ? (
          <p className="px-3 py-6 text-center text-[13px] text-fog-500">
            No matches for “{query.trim()}”.
          </p>
        ) : (
          results.map((result, i) => (
            <button
              key={result.conversation.id}
              type="button"
              onMouseEnter={() => setIndex(i)}
              onClick={() => select(result.conversation.id)}
              className={cn(
                "flex w-full flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left transition-colors",
                i === index ? "bg-ink-700" : "",
              )}
            >
              <span className="flex items-baseline justify-between gap-3">
                <span className="truncate text-[13.5px] font-medium text-fog-100">{result.conversation.title}</span>
                <span className="shrink-0 text-[11px] text-fog-600">{timeAgo(result.conversation.updatedAt)}</span>
              </span>
              <span className="truncate text-[12px] text-fog-500">{result.snippet}</span>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}

/* ---------------- engine power panel ---------------- */

const ENGINE_STATE_STYLE: Record<string, string> = {
  alive: "border-ok-400/30 bg-ok-400/10 text-ok-400",
  waking: "border-ember-400/30 bg-ember-400/10 text-ember-300",
  off: "border-line bg-ink-750 text-fog-500",
  quota: "border-danger-400/30 bg-danger-400/10 text-danger-400",
  unreachable: "border-warn-400/35 bg-warn-400/10 text-warn-400",
  error: "border-danger-400/30 bg-danger-400/10 text-danger-400",
};

/**
 * Per-slot health chip. Driven by a real /api/ps probe of that slot's OWN
 * engine — never by credential presence.
 *
 * FIX (audit §4.1 / P2.12): the old badge rendered "ready"/"no key" from
 * `engineConfigured()`, so a dead engine displayed as ready and a healthy engine
 * whose key had rotated displayed as broken.
 */
function HealthChip({ health, checked }: { health: SlotHealth; checked: boolean }) {
  const map: Record<SlotHealth, { label: string; cls: string; pulse: boolean }> = {
    live: { label: "live", cls: "border-ok-400/30 bg-ok-400/10 text-ok-400", pulse: false },
    waking: { label: "waking", cls: "border-ember-400/30 bg-ember-400/10 text-ember-300", pulse: true },
    offline: { label: checked ? "offline" : "no url", cls: "border-line bg-ink-750 text-fog-500", pulse: false },
  };
  const m = map[health];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium", m.cls)}>
      <span className={cn("size-1.5 rounded-full bg-current", m.pulse && "anim-pulse")} />
      {m.label}
    </span>
  );
}

const ENGINE_SLOTS = ["a", "b", "c"] as const;

function EnginePanel({ busy, snapshot, onRefresh }: { busy: boolean; snapshot: EngineSnapshot | null; onRefresh: () => void }) {
  /* Which slot is mid-wake, so each button shows its OWN state (audit §4.3). */
  const [wakingSlot, setWakingSlot] = useState<"a" | "b" | "c" | null>(null);

  const locked = busy || (snapshot?.activeOperations ?? 0) > 0;

  /* THE truth: a fresh fleet-wide /api/ps check. */
  const live = snapshot?.live;
  const actuallyLive = live?.alive ?? false;
  const anyWaking = ENGINE_SLOTS.some((id) => (snapshot?.engines[id]?.health ?? "offline") === "waking");

  const wake = async (engine: "a" | "b" | "c") => {
    setWakingSlot(engine);
    try {
      const result = await engineWake(engine);
      if (result.status === "alive") {
        toast(`Engine ${engine.toUpperCase()} is live.`, "ok");
      } else if (result.status === "waking") {
        toast(`Engine ${engine.toUpperCase()} is waking (${result.reason ?? "boot in progress"})…`, "info");
      } else {
        toast(`Engine ${engine.toUpperCase()}: ${result.message ?? "unavailable"}`, "info");
      }
      onRefresh();
    } finally {
      setWakingSlot(null);
    }
  };

  const shutdown = async () => {
    setWakingSlot(null);
    try {
      const result = await engineOff();
      const anyShutdown = result.killed?.some((k) => k.result === "shutdown");
      toast(result.message ?? (anyShutdown ? "Engines shut down." : "No running engines."), anyShutdown ? "ok" : "info");
      onRefresh();
    } finally {
      onRefresh();
    }
  };

  /*
   * Only a server that stays alive between requests can honour this countdown.
   * On a serverless runtime the clock restarts on every cold start, so showing
   * "~N min left" would be a fabrication (audit R3).
   */
  const idleAuthoritative = snapshot?.idleOff?.authoritative ?? false;
  const idleMinutesLeft =
    snapshot && idleAuthoritative
      ? Math.max(0, snapshot.idleLimitMinutes - snapshot.idleMs / 60_000)
      : null;

  return (
    <div className="mt-1 px-1">
      <p className="px-1 pb-1.5 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-fog-600">
        Engine power · three Kaggle GPUs
      </p>
      <div className="rounded-xl border border-line bg-ink-800 p-3.5">
        {/* Truthful live banner — driven by a fresh /api/ps health check.
            FIX (audit A8 / §6.6): the internal tunnel URL is never rendered.
            It is an unauthenticated RCE endpoint on the engine host. */}
        <div
          className={cn(
            "mb-2 flex items-center gap-2 rounded-lg border px-3 py-2",
            actuallyLive && "border-ok-400/30 bg-ok-400/10",
            !actuallyLive && anyWaking && "border-ember-400/30 bg-ember-400/10",
            !actuallyLive && !anyWaking && "border-line bg-ink-850",
          )}
        >
          <span
            className={cn(
              "size-2 rounded-full",
              actuallyLive ? "bg-ok-400" : anyWaking ? "anim-pulse bg-ember-400" : "bg-fog-600",
            )}
          />
          <div className="min-w-0 flex-1">
            <span
              className={cn(
                "block text-[12px] font-semibold",
                actuallyLive ? "text-ok-400" : anyWaking ? "text-ember-300" : "text-fog-400",
              )}
            >
              {actuallyLive
                ? `Engine ${(live?.slot ?? "a").toUpperCase()} live`
                : anyWaking
                  ? "Engine waking…"
                  : "No engine live"}
            </span>
            <span className="block truncate text-[10px] text-fog-600">
              {actuallyLive ? "confirmed by /api/ps" : "health-checked just now"}
            </span>
          </div>
          <span className="shrink-0 text-[9.5px] uppercase tracking-wide text-fog-600">
            {live?.latencyMs != null ? `${live.latencyMs} ms` : "—"}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {ENGINE_SLOTS.map((id) => {
            const info = snapshot?.engines[id];
            const health = info?.health ?? "offline";
            const configured = info?.configured ?? false;
            /* FIX (audit §4.2 / P2.13): a slot's Wake button is disabled only
               when THAT slot is already live — you can now bring up B while A
               is serving, which is what manual failover requires. */
            const alreadyLive = health === "live";
            const isWaking = wakingSlot === id || health === "waking";
            /* FIX (audit A5): a rotated tunnel the server had to evict. */
            const stale = info?.state === "unreachable";
            return (
              <div key={id} className="rounded-lg border border-line bg-ink-850 px-3 py-2.5">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[12px] font-semibold text-fog-200">Engine {id.toUpperCase()}</span>
                  <HealthChip health={health} checked={info?.healthChecked ?? false} />
                </div>
                {/* Credential presence is a separate fact from health. */}
                <div className="mt-1 flex items-center justify-between gap-1">
                  <span className={cn("text-[9.5px]", configured ? "text-fog-600" : "text-danger-400")}>
                    {configured ? "key set" : "no key"}
                  </span>
                  {stale ? <span className="text-[9.5px] text-ember-300">url rotated</span> : null}
                </div>
                <button
                  type="button"
                  disabled={busy || isWaking || alreadyLive}
                  onClick={() => void wake(id)}
                  className="mt-2 w-full rounded-md border border-line-strong px-2 py-1 text-[11px] text-fog-300 transition-colors hover:bg-ink-700 disabled:opacity-40"
                >
                  {isWaking ? "Waking…" : alreadyLive ? "Live" : "Wake"}
                </button>
              </div>
            );
          })}
        </div>

        {/* FIX (audit §4.5 / P2.14): ONE shutdown control. The header power
            button and this panel previously called two different code paths
            with two different behaviours. */}
        <button
          type="button"
          disabled={locked || !actuallyLive}
          onClick={() => void shutdown()}
          className={cn(
            "mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-danger-400/30 px-3 py-2 text-[12px] font-medium text-danger-400 transition-colors hover:bg-danger-400/10",
            (locked || !actuallyLive) && "cursor-not-allowed opacity-40",
          )}
        >
          <Icon name="stop" size={11} />
          {!actuallyLive ? "No live engine to stop" : locked ? "Locked while work is running" : "Shut down all engines"}
        </button>

        <div className="mt-2.5 space-y-1 text-[11px] leading-relaxed text-fog-600">
          <p>
            Model: <span className="font-mono text-fog-500">{snapshot?.model ?? "…"}</span>
          </p>
          <p>
            Credentials:{" "}
            {ENGINE_SLOTS.map((slot, i) => (
              <span key={slot}>
                {i > 0 ? " · " : ""}
                <span className={snapshot?.engines[slot]?.configured ? "text-ok-400" : "text-fog-500"}>
                  {slot.toUpperCase()} {snapshot?.engines[slot]?.configured ? "set" : "missing"}
                </span>
              </span>
            ))}
          </p>
          <p>
            {idleAuthoritative ? (
              <>
                Auto idle-off after <span className="text-fog-400">{snapshot?.idleLimitMinutes ?? 20} min</span> of true
                inactivity{idleMinutesLeft !== null && snapshot && snapshot.idleLimitMinutes > 0 ? ` — ~${Math.ceil(idleMinutesLeft)} min left` : ""}.
              </>
            ) : (
              <>
                Idle shutdown is enforced by <span className="text-fog-400">the engine itself</span>; this runtime
                recycles the server process between requests, so it cannot hold an idle clock.
              </>
            )}
            {!snapshot?.kaggleConfigured ? " Set the Kaggle environment variables to activate the engines." : ""}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ---------------- settings ---------------- */

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (next: boolean) => void; label: string; hint: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-ink-800">
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] text-fog-100">{label}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-fog-500">{hint}</span>
      </span>
      <span
        className={cn(
          "relative h-5.5 w-10 shrink-0 rounded-full border transition-colors",
          checked ? "border-ember-400/50 bg-ember-400/90" : "border-line-strong bg-ink-700",
        )}
      >
        <span
          className={cn(
            "absolute top-1/2 size-4 -translate-y-1/2 rounded-full shadow transition-all",
            checked ? "left-[calc(100%-18px)] bg-ink-950" : "left-0.5 bg-fog-400",
          )}
        />
      </span>
    </button>
  );
}

export function SettingsModal({
  settings,
  online,
  busy,
  onClose,
  onUpdate,
  onExport,
  onWipe,
}: {
  settings: Settings;
  online: boolean;
  /** True while the agent is responding — power controls are locked. */
  busy: boolean;
  onClose: () => void;
  onUpdate: (patch: Partial<Settings>) => void;
  onExport: () => void;
  onWipe: () => void;
}) {
  const [confirmingWipe, setConfirmingWipe] = useState(false);
  const { snapshot, refresh: refreshEngines } = useEngineSnapshot(online, 4_000);

  const routes: Array<{ id: Settings["provider"]; name: string; desc: string }> = [
    { id: "auto", name: "Auto", desc: "Use any available engine. Failover order: A → B → C." },
    { id: "a", name: "Engine A", desc: "Strictly engine A — never silently switched away." },
    { id: "b", name: "Engine B", desc: "Strictly engine B — never silently switched away." },
    { id: "c", name: "Engine C", desc: "Strictly engine C — never silently switched away." },
  ];

  return (
    <Modal onClose={onClose}>
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <h2 className="font-display text-[15px] font-semibold text-fog-100">Settings</h2>
        <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-fog-500 transition-colors hover:bg-ink-800 hover:text-fog-200" aria-label="Close settings">
          <Icon name="x" size={15} />
        </button>
      </div>

      <div className="max-h-[62vh] overflow-y-auto px-3 py-3">
        <p className="px-2 pb-1.5 pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-fog-600">
          Engine routing
        </p>
        <div className="space-y-1.5 px-1">
          {routes.map((route) => {
            const selected = settings.provider === route.id;
            const engineInfo = route.id === "auto" ? null : snapshot?.engines[route.id];
            /* FIX (audit A2 / §4.4): the chip reports REAL health from that
               slot's own /api/ps probe. The old code showed the manager's
               internal lifecycle `state`, which on serverless read "off"/"a"
               regardless of what was actually serving. */
            const health = engineInfo?.health ?? null;
            /* Which slot is genuinely serving right now (fleet-wide probe). */
            const servingSlot = snapshot?.live?.alive ? snapshot.live.slot : null;
            return (
              <button
                key={route.id}
                type="button"
                onClick={() => onUpdate({ provider: route.id })}
                className={cn(
                  "flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors",
                  selected ? "border-ember-400/45 bg-ember-400/5" : "border-line bg-ink-800 hover:border-line-strong",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                    selected ? "border-ember-400 bg-ember-400" : "border-line-strong",
                  )}
                >
                  {selected ? <span className="size-1.5 rounded-full bg-ink-950" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-[13.5px] font-medium text-fog-100">
                    {route.name}
                    {/* "serving" is only ever shown against a slot that a fresh
                        /api/ps probe confirmed — and for AUTO, against the slot
                        actually answering, so the two never disagree. */}
                    {route.id === "auto"
                      ? servingSlot
                        ? <span className="rounded border border-ok-400/35 px-1.5 py-px text-[9.5px] uppercase tracking-wide text-ok-400">
                            serving {servingSlot.toUpperCase()}
                          </span>
                        : null
                      : servingSlot === route.id
                        ? <span className="rounded border border-ok-400/35 px-1.5 py-px text-[9.5px] uppercase tracking-wide text-ok-400">
                            serving
                          </span>
                        : null}
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-relaxed text-fog-500">{route.desc}</span>
                </span>
                {health ? <span className="mt-0.5 shrink-0"><HealthChip health={health} checked={engineInfo?.healthChecked ?? false} /></span> : null}
              </button>
            );
          })}
          <p className="px-2 pt-1 text-[11.5px] leading-relaxed text-fog-600">
            <Icon name="globe" size={11} className="mr-1 inline text-fog-600" />
            Credentials never reach the browser — wake, routing and shutdown are fully server-side.
          </p>
        </div>

        <EnginePanel busy={busy} snapshot={snapshot} onRefresh={refreshEngines} />

        <p className="px-2 pb-1 pt-4 text-[10.5px] font-semibold uppercase tracking-wider text-fog-600">Behavior</p>
        <Toggle
          checked={settings.streaming}
          onChange={(next) => onUpdate({ streaming: next })}
          label="Stream responses"
          hint="Reveal the agent's reply token by token instead of all at once."
        />
        <Toggle
          checked={settings.reduceMotion}
          onChange={(next) => onUpdate({ reduceMotion: next })}
          label="Reduce motion"
          hint="Minimize animations across the workspace."
        />

        <p className="px-2 pb-1 pt-4 text-[10.5px] font-semibold uppercase tracking-wider text-fog-600">Data</p>
        <div className="space-y-1.5 px-1 pb-2">
          <button
            type="button"
            onClick={onExport}
            className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-ink-800 px-3.5 py-2.5 text-[13px] text-fog-200 transition-colors hover:border-line-strong"
          >
            <Icon name="download" size={14} className="text-fog-500" />
            Export workspace as JSON
          </button>
          {confirmingWipe ? (
            <div className="flex items-center gap-2 rounded-xl border border-danger-400/30 bg-danger-400/10 px-3.5 py-2.5">
              <span className="flex-1 text-[12.5px] text-danger-400">Delete every conversation, project and file?</span>
              <button
                type="button"
                onClick={() => {
                  onWipe();
                  setConfirmingWipe(false);
                  onClose();
                }}
                className="rounded-lg bg-danger-400 px-2.5 py-1 text-[12px] font-semibold text-ink-950 transition-colors hover:bg-danger-400/85"
              >
                Wipe
              </button>
              <button
                type="button"
                onClick={() => setConfirmingWipe(false)}
                className="rounded-lg px-2 py-1 text-[12px] text-fog-400 transition-colors hover:text-fog-200"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingWipe(true)}
              className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-ink-800 px-3.5 py-2.5 text-[13px] text-danger-400 transition-colors hover:border-danger-400/35"
            >
              <Icon name="trash" size={14} />
              Wipe local workspace…
            </button>
          )}
          <p className="px-2 pt-1 text-[11.5px] leading-relaxed text-fog-600">
            All data is stored in this browser via IndexedDB. Nothing is uploaded anywhere.
          </p>
        </div>
      </div>
    </Modal>
  );
}
