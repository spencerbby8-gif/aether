"use client";

import { useCallback, useEffect, useState } from "react";
import type { MemoryEntry, MemoryScope } from "@/lib/types";
import { cn, timeAgo, toast } from "@/lib/utils";
import { MemoryStore } from "@/storage";
import { Icon } from "./icons";

const SCOPES: Array<{ scope: MemoryScope; label: string; hint: string }> = [
  { scope: "fact", label: "Facts & decisions", hint: "Important things the agent should keep in mind." },
  { scope: "preference", label: "Preferences", hint: "How you like things done — always saved with your approval." },
  { scope: "conversation", label: "Conversation memory", hint: "Notes anchored to specific conversations." },
  { scope: "project", label: "Project memory", hint: "Context anchored to projects." },
  { scope: "task", label: "Task memory", hint: "Outcomes worth remembering from agent runs." },
];

/** Inspectable, deletable local agent memory. */
export function MemoryView({ refreshKey }: { refreshKey: number }) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [scope, setScope] = useState<MemoryScope>("fact");
  const [draft, setDraft] = useState("");

  const reload = useCallback(async () => {
    try {
      setEntries(await MemoryStore.list());
    } catch {
      setEntries([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const add = async () => {
    const content = draft.trim();
    if (!content) return;
    await MemoryStore.add({ scope, content });
    setDraft("");
    toast("Saved to memory", "ok");
    void reload();
  };

  const remove = async (id: string) => {
    await MemoryStore.remove(id);
    toast("Memory deleted");
    void reload();
  };

  return (
    <div>
      <div className="flex items-start gap-3 rounded-xl border border-line bg-ink-850/60 px-4 py-3.5">
        <Icon name="brain" size={15} className="mt-0.5 shrink-0 text-ember-400" />
        <p className="text-[12.5px] leading-relaxed text-fog-500">
          Memory is <span className="text-fog-300">curated, inspectable and deletable</span> — facts, decisions and
          approved preferences. Messages themselves are never stored here; full transcripts stay in conversations.
        </p>
      </div>

      {/* add form */}
      <div className="mt-4 rounded-xl border border-line bg-ink-850 p-3.5">
        <div className="flex flex-wrap gap-1.5">
          {SCOPES.map((item) => (
            <button
              key={item.scope}
              type="button"
              title={item.hint}
              onClick={() => setScope(item.scope)}
              className={cn(
                "rounded-lg border px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                scope === item.scope
                  ? "border-ember-400/45 bg-ember-400/10 text-ember-300"
                  : "border-line bg-ink-800 text-fog-400 hover:text-fog-200",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="mt-2.5 flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
            placeholder="Add a memory entry…"
            className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-ink-800 px-3 text-[13px] text-fog-100 placeholder:text-fog-600 focus:border-fog-600/60 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={!draft.trim()}
            className="rounded-lg bg-ember-400 px-3.5 text-[12.5px] font-semibold text-ink-950 transition-colors hover:bg-ember-300 disabled:opacity-40"
          >
            Add
          </button>
        </div>
      </div>

      {/* grouped entries */}
      {!loaded ? (
        <div className="mt-4 space-y-2">
          <div className="skeleton h-16" />
          <div className="skeleton h-16 w-4/5" />
        </div>
      ) : entries.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-fog-500">
          Memory is empty. Entries appear when you add them here or when the agent stores facts during a task.
        </div>
      ) : (
        SCOPES.map(({ scope: groupScope, label }) => {
          const group = entries.filter((e) => e.scope === groupScope);
          if (group.length === 0) return null;
          return (
            <div key={groupScope} className="mt-4">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fog-600">
                {label} <span className="text-fog-600/70">({group.length})</span>
              </h3>
              <div className="overflow-hidden rounded-xl border border-line bg-ink-850">
                {group.map((entry, index) => (
                  <div
                    key={entry.id}
                    className={cn("group flex items-start gap-3 px-3.5 py-2.5", index > 0 && "border-t border-line")}
                  >
                    <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-fog-200">{entry.content}</p>
                    <span className="mt-0.5 shrink-0 text-[10.5px] text-fog-600">{timeAgo(entry.updatedAt)}</span>
                    <button
                      type="button"
                      onClick={() => void remove(entry.id)}
                      className="mt-0.5 shrink-0 rounded-md p-1 text-fog-600 opacity-0 transition-all hover:bg-danger-400/15 hover:text-danger-400 group-hover:opacity-100"
                      aria-label="Delete memory entry"
                    >
                      <Icon name="trash" size={12.5} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
