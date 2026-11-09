"use client";

import { useEffect, useRef, useState } from "react";
import type { ModelSelection, Settings } from "@/lib/types";
import { useByokConnections } from "@/hooks/useByok";
import { cn } from "@/lib/utils";
import { Icon, Logo } from "./icons";

export function ModelSelector({
  settings,
  onUpdate,
  onOpenSettings,
}: {
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { connections } = useByokConnections();
  const selection = settings.model;
  const selectedConnection = selection.kind === "byok"
    ? connections.find((connection) => connection.id === selection.connectionId)
    : undefined;
  const selectedLabel = selection.kind === "aether"
    ? "Aether Uncensored"
    : selectedConnection
      ? `${selectedConnection.name} · ${selection.model}`
      : "Personal provider unavailable";

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const choose = (model: ModelSelection) => {
    onUpdate({ model });
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      {open ? (
        <div
          className="anim-pop absolute bottom-[calc(100%+9px)] left-0 z-50 max-h-[min(520px,65vh)] w-[min(390px,calc(100vw-32px))] overflow-y-auto rounded-2xl border border-line-strong bg-ink-850 p-2 shadow-2xl shadow-black/50"
          role="dialog"
          aria-label="Choose a chat model"
          data-testid="model-selector-popover"
        >
          <div className="px-2 pb-2 pt-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog-500">Chat model</p>
            <p className="mt-1 text-xs leading-5 text-fog-500">Choose Aether or a model from your own provider.</p>
          </div>
          <button
            type="button"
            onClick={() => choose({ kind: "aether" })}
            className={cn(
              "flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors",
              selection.kind === "aether" ? "border-ember-400/30 bg-ember-400/[0.07]" : "border-transparent hover:bg-ink-750",
            )}
            data-testid="select-aether-uncensored"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-ember-400/20 bg-ink-900 text-ember-400">
              <Logo size={19} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-semibold text-fog-100">
                Aether Uncensored
                <span className="rounded-full border border-line px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-fog-500">Agent tools</span>
              </span>
              <span className="mt-0.5 block text-xs text-fog-500">Automatic routing and sequential fallback</span>
            </span>
            {selection.kind === "aether" ? <Icon name="check" size={16} className="shrink-0 text-ember-400" /> : null}
          </button>

          {connections.length > 0 ? (
            <div className="mt-2 border-t border-line pt-2">
              <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-fog-600">Your providers</p>
              {connections.map((connection) => {
                const active = selection.kind === "byok" && selection.connectionId === connection.id;
                const models = connection.models.length > 0 ? connection.models : [connection.defaultModel].filter(Boolean);
                return (
                  <div
                    key={connection.id}
                    className={cn(
                      "mt-1 rounded-xl border p-3 transition-colors",
                      active ? "border-ember-400/30 bg-ember-400/[0.07]" : "border-transparent bg-ink-900/40",
                      !connection.enabled && "opacity-55",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={!connection.enabled || !connection.defaultModel}
                        onClick={() => choose({ kind: "byok", connectionId: connection.id, model: active ? selection.model : connection.defaultModel })}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-not-allowed"
                      >
                        <span className={cn("size-2 shrink-0 rounded-full", active ? "bg-ember-400" : "bg-fog-600")} />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-fog-200">{connection.name}</span>
                          <span className="block text-[11px] text-fog-500">
                            {!connection.enabled ? "Disabled" : connection.lastTest?.status === "verified" ? "Connection verified" : "Key saved · not verified"}
                          </span>
                        </span>
                      </button>
                      {active ? <Icon name="check" size={15} className="text-ember-400" /> : null}
                    </div>
                    <select
                      aria-label={`Model for ${connection.name}`}
                      value={active ? selection.model : connection.defaultModel}
                      disabled={!connection.enabled || models.length === 0}
                      onChange={(event) => choose({ kind: "byok", connectionId: connection.id, model: event.target.value })}
                      className="mt-2 h-9 w-full rounded-lg border border-line bg-ink-900 px-2.5 font-mono text-[11px] text-fog-300 outline-none focus:border-ember-400/40 disabled:opacity-50"
                    >
                      {models.map((model) => <option key={model} value={model}>{model}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => { setOpen(false); onOpenSettings(); }}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-line px-3 py-2.5 text-xs font-medium text-fog-300 transition-colors hover:bg-ink-750 hover:text-fog-100"
          >
            <Icon name="plus" size={14} /> Manage personal providers
          </button>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex max-w-[min(430px,calc(100vw-90px))] items-center gap-2 rounded-lg border border-line bg-ink-900/70 px-2.5 py-1.5 text-left text-[11px] text-fog-400 transition-colors hover:border-line-strong hover:text-fog-200"
        data-testid="model-selector-trigger"
      >
        {selection.kind === "aether" ? <Logo size={14} className="shrink-0 text-ember-400" /> : <Icon name="globe" size={14} className="shrink-0 text-ember-400" />}
        <span className="truncate">{selectedLabel}</span>
        <Icon name="chevronDown" size={12} className={cn("shrink-0 transition-transform", open && "rotate-180")} />
      </button>
    </div>
  );
}
