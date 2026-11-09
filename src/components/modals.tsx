"use client";

import { useEffect, useRef, useState } from "react";
import type { SearchResult } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";
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

export { SettingsModal } from "./settings";
