"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { announceByokChanged, useByokConnections } from "@/hooks/useByok";
import { controlAuthHeaders } from "@/lib/control-auth";
import {
  BYOK_PROVIDERS,
  normalizeBaseUrl,
  normalizeModels,
  providerDefinition,
  type ByokConnection,
  type ByokProviderId,
  type ByokTestResult,
} from "@/lib/byok";
import type { Settings, WorkspaceStats } from "@/lib/types";
import { ByokStore } from "@/storage/ByokStore";
import { workspaceStats } from "@/storage";
import { cn, toast } from "@/lib/utils";
import { Icon, Logo, type IconName } from "./icons";

type Section = "general" | "agent" | "providers" | "appearance" | "data";

const SECTIONS: Array<{ id: Section; label: string; icon: IconName; description: string }> = [
  { id: "general", label: "General", icon: "settings", description: "Chat behavior and defaults" },
  { id: "agent", label: "Agent", icon: "brain", description: "Instructions and generation" },
  { id: "providers", label: "Models & BYOK", icon: "globe", description: "Personal provider connectors" },
  { id: "appearance", label: "Appearance", icon: "sparkle", description: "Motion and layout" },
  { id: "data", label: "Data & privacy", icon: "folder", description: "Exports, keys, and storage" },
];

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
  busy: boolean;
  onClose: () => void;
  onUpdate: (patch: Partial<Settings>) => void;
  onExport: () => void | Promise<void>;
  onWipe: () => void | Promise<void>;
}) {
  const [section, setSection] = useState<Section>("general");
  const active = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0];

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-0 backdrop-blur-sm sm:p-5" role="dialog" aria-modal="true" aria-label="Aether Settings">
      <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} aria-label="Close Settings" />
      <div className="anim-pop relative flex h-full w-full max-w-6xl flex-col overflow-hidden bg-ink-900 shadow-2xl sm:h-[min(790px,92vh)] sm:rounded-2xl sm:border sm:border-line-strong" data-testid="settings-panel">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-line px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-xl border border-ember-400/20 bg-ink-800 text-ember-400"><Logo size={20} /></span>
            <div>
              <h2 className="font-display text-base font-semibold">Settings</h2>
              <p className="hidden text-[11px] text-fog-500 sm:block">Aether workspace and personal providers</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-fog-500 hover:bg-ink-800 hover:text-fog-200" aria-label="Close Settings"><Icon name="x" size={19} /></button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-line p-2 md:w-60 md:flex-col md:overflow-visible md:border-b-0 md:border-r md:p-3" aria-label="Settings sections">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                aria-current={section === item.id ? "page" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition-colors md:w-full",
                  section === item.id ? "bg-ember-400/10 text-ember-300" : "text-fog-400 hover:bg-ink-800 hover:text-fog-200",
                )}
                data-testid={`settings-tab-${item.id}`}
              >
                <Icon name={item.icon} size={16} />
                <span>{item.label}</span>
              </button>
            ))}
            <div className="mt-auto hidden px-3 pb-2 pt-6 md:block">
              <p className="text-[10px] leading-4 text-fog-600">Settings and provider keys are stored locally in this browser.</p>
            </div>
          </nav>

          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl px-4 py-6 sm:px-7 sm:py-8">
              <div className="mb-6">
                <h3 className="font-display text-xl font-semibold tracking-tight">{active.label}</h3>
                <p className="mt-1 text-[13px] text-fog-500">{active.description}</p>
              </div>
              {section === "general" ? <GeneralSettings settings={settings} onUpdate={onUpdate} onOpenProviders={() => setSection("providers")} /> : null}
              {section === "agent" ? <AgentSettings settings={settings} onUpdate={onUpdate} /> : null}
              {section === "providers" ? <ProviderSettings settings={settings} onUpdate={onUpdate} /> : null}
              {section === "appearance" ? <AppearanceSettings settings={settings} onUpdate={onUpdate} /> : null}
              {section === "data" ? <DataSettings online={online} busy={busy} onExport={onExport} onWipe={onWipe} onUpdate={onUpdate} /> : null}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

function SettingsGroup({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="mb-5 overflow-hidden rounded-2xl border border-line bg-ink-850/60">
      <div className="border-b border-line px-4 py-3.5 sm:px-5">
        <h4 className="text-[13px] font-semibold text-fog-200">{title}</h4>
        {description ? <p className="mt-1 text-xs leading-5 text-fog-500">{description}</p> : null}
      </div>
      <div className="divide-y divide-line">{children}</div>
    </section>
  );
}

function SettingRow({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0 sm:pr-6">
        <p className="text-[13px] font-medium text-fog-200">{title}</p>
        {description ? <p className="mt-1 text-xs leading-5 text-fog-500">{description}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn("relative h-6 w-11 rounded-full border transition-colors", checked ? "border-ember-400/50 bg-ember-400" : "border-line-strong bg-ink-700")}
    >
      <span className={cn("absolute top-[3px] size-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[22px]" : "translate-x-[3px]")} />
    </button>
  );
}

const inputClass = "h-10 w-full rounded-xl border border-line bg-ink-900 px-3 text-[13px] text-fog-200 outline-none transition-colors placeholder:text-fog-600 focus:border-ember-400/40";
const labelClass = "mb-1.5 block text-xs font-medium text-fog-400";

function GeneralSettings({ settings, onUpdate, onOpenProviders }: { settings: Settings; onUpdate: (patch: Partial<Settings>) => void; onOpenProviders: () => void }) {
  const modelLabel = settings.model.kind === "aether" ? "Aether Uncensored" : "Personal provider model";
  return (
    <>
      <SettingsGroup title="Chat" description="Core behavior for new conversations. Changes save automatically.">
        <SettingRow title="Default model" description="Use the model selector in the composer to switch at any time.">
          <button type="button" onClick={onOpenProviders} className="flex h-9 items-center gap-2 rounded-lg border border-line bg-ink-900 px-3 text-xs text-fog-300 hover:border-line-strong">
            <span className="max-w-44 truncate">{modelLabel}</span><Icon name="chevronDown" size={12} />
          </button>
        </SettingRow>
        <SettingRow title="Send with Enter" description="When off, use Ctrl+Enter or Cmd+Enter to send. Shift+Enter always adds a newline.">
          <Switch checked={settings.sendOnEnter} onChange={(sendOnEnter) => onUpdate({ sendOnEnter })} label="Send with Enter" />
        </SettingRow>
        <SettingRow title="Stream responses" description="Personal providers honor this setting. Aether Uncensored keeps its event stream active for agent progress and tools.">
          <Switch checked={settings.streaming} onChange={(streaming) => onUpdate({ streaming })} label="Stream responses" />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Aether Uncensored" description="The built-in agent is presented as one unified model. Automatic sequential fallback is always enabled.">
        <div className="flex items-start gap-3 px-4 py-4 sm:px-5">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-ember-400/20 text-ember-400"><Logo size={17} /></span>
          <div>
            <p className="text-[13px] font-medium text-fog-200">Unified automatic routing</p>
            <p className="mt-1 text-xs leading-5 text-fog-500">Failures and capacity limits move through the private fleet without exposing routing identities in chat.</p>
          </div>
        </div>
      </SettingsGroup>
    </>
  );
}

function AgentSettings({ settings, onUpdate }: { settings: Settings; onUpdate: (patch: Partial<Settings>) => void }) {
  return (
    <>
      <SettingsGroup title="Custom instructions" description="Added to each new chat request. Aether receives them as user-scoped context; personal providers receive a system message.">
        <div className="px-4 py-4 sm:px-5">
          <textarea
            value={settings.systemPrompt}
            onChange={(event) => onUpdate({ systemPrompt: event.target.value.slice(0, 8000) })}
            placeholder="Example: Answer concisely, state assumptions, and include verification steps for technical work."
            rows={6}
            className="w-full resize-y rounded-xl border border-line bg-ink-900 p-3 text-[13px] leading-6 text-fog-200 outline-none placeholder:text-fog-600 focus:border-ember-400/40"
            aria-label="Custom instructions"
          />
          <p className="mt-2 text-right text-[10px] text-fog-600">{settings.systemPrompt.length} / 8,000</p>
        </div>
      </SettingsGroup>
      <SettingsGroup title="Personal provider generation" description="These controls apply to BYOK chat. The Aether fleet retains its server-managed agent configuration.">
        <SettingRow title="Temperature" description="Lower values are more deterministic; higher values are more varied (0–2).">
          <input type="number" min={0} max={2} step={0.1} value={settings.temperature} onChange={(event) => onUpdate({ temperature: Number(event.target.value) })} className={cn(inputClass, "w-28")} aria-label="Temperature" />
        </SettingRow>
        <SettingRow title="Maximum output tokens" description="Upper bound requested from the provider; actual provider and model limits still apply.">
          <input type="number" min={1} max={32768} step={1} value={settings.maxTokens} onChange={(event) => onUpdate({ maxTokens: Number(event.target.value) })} className={cn(inputClass, "w-32")} aria-label="Maximum output tokens" />
        </SettingRow>
        <SettingRow title="Request timeout" description="Stop a personal provider request after this duration (10–180 seconds).">
          <select value={settings.requestTimeoutMs} onChange={(event) => onUpdate({ requestTimeoutMs: Number(event.target.value) })} className={cn(inputClass, "w-32")} aria-label="Request timeout">
            <option value={10000}>10 seconds</option><option value={30000}>30 seconds</option><option value={60000}>60 seconds</option><option value={120000}>120 seconds</option><option value={180000}>180 seconds</option>
          </select>
        </SettingRow>
      </SettingsGroup>
      <div className="rounded-xl border border-line bg-ink-850/50 p-4 text-xs leading-5 text-fog-500">
        <span className="font-medium text-fog-300">Tool availability:</span> Aether workspace tools currently run through Aether Uncensored. Personal providers use their chat completions API and do not receive workspace tool access.
      </div>
    </>
  );
}

interface ProviderDraft {
  provider: ByokProviderId;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelsText: string;
  defaultModel: string;
  enabled: boolean;
}

function draftFor(provider: ByokProviderId, connection?: ByokConnection): ProviderDraft {
  const definition = providerDefinition(provider);
  return {
    provider,
    name: connection?.name ?? definition.name,
    baseUrl: connection?.baseUrl ?? definition.baseUrl,
    apiKey: "",
    modelsText: connection?.models.join("\n") ?? definition.suggestedModels.join("\n"),
    defaultModel: connection?.defaultModel ?? definition.suggestedModels[0] ?? "",
    enabled: connection?.enabled ?? true,
  };
}

function ProviderSettings({ settings, onUpdate }: { settings: Settings; onUpdate: (patch: Partial<Settings>) => void }) {
  const { connections, refresh } = useByokConnections();
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const editing = editingId && editingId !== "new" ? connections.find((connection) => connection.id === editingId) : undefined;

  const changed = async () => {
    await refresh();
    announceByokChanged();
  };

  const remove = async (connection: ByokConnection) => {
    if (!window.confirm(`Remove ${connection.name} and its saved API key from this browser?`)) return;
    await ByokStore.remove(connection.id);
    if (settings.model.kind === "byok" && settings.model.connectionId === connection.id) onUpdate({ model: { kind: "aether" } });
    await changed();
    toast("Provider and local key removed.");
  };

  const toggle = async (connection: ByokConnection) => {
    await ByokStore.update(connection.id, { enabled: !connection.enabled });
    if (connection.enabled && settings.model.kind === "byok" && settings.model.connectionId === connection.id) onUpdate({ model: { kind: "aether" } });
    await changed();
  };

  return (
    <>
      <div className="mb-5 flex items-start justify-between gap-4 rounded-2xl border border-ember-400/15 bg-ember-400/[0.035] p-4">
        <div>
          <h4 className="text-[13px] font-semibold text-fog-200">Bring Your Own Keys</h4>
          <p className="mt-1 max-w-xl text-xs leading-5 text-fog-500">Connect an OpenAI-compatible chat provider. Keys remain in this browser, are excluded from workspace exports, and are sent request-only through Aether’s server proxy.</p>
        </div>
        <button type="button" onClick={() => setEditingId("new")} className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-ember-400 px-3 text-xs font-semibold text-ink-950 hover:bg-ember-300" data-testid="add-provider"><Icon name="plus" size={14} /> Add provider</button>
      </div>

      {editingId ? (
        <ProviderEditor
          key={editingId}
          connection={editing}
          onCancel={() => setEditingId(null)}
          onSaved={async (connection) => {
            setEditingId(null);
            await changed();
            if (settings.model.kind === "byok" && settings.model.connectionId === connection.id) onUpdate({ model: { kind: "byok", connectionId: connection.id, model: connection.defaultModel } });
          }}
        />
      ) : (
        <div className="space-y-3">
          {connections.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line-strong px-5 py-10 text-center">
              <span className="mx-auto flex size-11 items-center justify-center rounded-xl border border-line bg-ink-850 text-fog-500"><Icon name="globe" size={20} /></span>
              <h4 className="mt-4 text-sm font-semibold text-fog-200">No personal providers yet</h4>
              <p className="mx-auto mt-2 max-w-md text-xs leading-5 text-fog-500">Add a provider to discover its available models and select one from the chat composer. Aether Uncensored remains available independently.</p>
            </div>
          ) : connections.map((connection) => (
            <article key={connection.id} className="rounded-2xl border border-line bg-ink-850/60 p-4" data-testid="provider-card">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-semibold text-fog-100">{connection.name}</h4>
                    <span className={cn("rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider", connection.lastTest?.status === "verified" ? "border-ok-400/20 bg-ok-400/10 text-ok-400" : connection.lastTest?.status === "failed" ? "border-danger-400/20 bg-danger-400/10 text-danger-400" : "border-line text-fog-500")}>
                      {connection.lastTest?.status === "verified" ? "Verified" : connection.lastTest?.status === "failed" ? "Test failed" : "Not verified"}
                    </span>
                    {!connection.enabled ? <span className="text-[10px] text-fog-600">Disabled</span> : null}
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-fog-500">{connection.baseUrl}</p>
                  <p className="mt-1 text-[11px] text-fog-600">Key saved locally · {connection.models.length} model{connection.models.length === 1 ? "" : "s"} configured</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Switch checked={connection.enabled} onChange={() => void toggle(connection)} label={`${connection.enabled ? "Disable" : "Enable"} ${connection.name}`} />
                  <button type="button" onClick={() => setEditingId(connection.id)} className="rounded-lg border border-line p-2 text-fog-400 hover:bg-ink-800 hover:text-fog-100" aria-label={`Edit ${connection.name}`}><Icon name="pencil" size={14} /></button>
                  <button type="button" onClick={() => void remove(connection)} className="rounded-lg border border-line p-2 text-fog-500 hover:border-danger-400/30 hover:bg-danger-400/10 hover:text-danger-400" aria-label={`Remove ${connection.name}`}><Icon name="trash" size={14} /></button>
                </div>
              </div>
              <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3 sm:flex-row sm:items-center">
                <label className="text-[11px] text-fog-500" htmlFor={`default-${connection.id}`}>Default model</label>
                <select
                  id={`default-${connection.id}`}
                  value={connection.defaultModel}
                  onChange={async (event) => {
                    await ByokStore.update(connection.id, { defaultModel: event.target.value });
                    if (settings.model.kind === "byok" && settings.model.connectionId === connection.id) onUpdate({ model: { kind: "byok", connectionId: connection.id, model: event.target.value } });
                    await changed();
                  }}
                  className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-ink-900 px-2.5 font-mono text-[11px] text-fog-300 outline-none focus:border-ember-400/40"
                >
                  {(connection.models.length ? connection.models : [connection.defaultModel]).map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              </div>
              {connection.lastTest ? <p className={cn("mt-2 text-[11px] leading-4", connection.lastTest.status === "verified" ? "text-fog-500" : "text-danger-400")}>{connection.lastTest.message} · {new Date(connection.lastTest.checkedAt).toLocaleString()}</p> : null}
            </article>
          ))}
        </div>
      )}

      <div className="mt-5 rounded-xl border border-line p-4 text-xs leading-5 text-fog-500">
        <p className="font-medium text-fog-300">Security scope</p>
        <p className="mt-1">Browser storage is not encrypted secret management. Anyone with access to this browser profile may be able to read saved keys. Aether does not claim server-side key persistence, per-user vaulting, or provider availability until a real test succeeds.</p>
      </div>
    </>
  );
}

function ProviderEditor({ connection, onCancel, onSaved }: { connection?: ByokConnection; onCancel: () => void; onSaved: (connection: ByokConnection) => void | Promise<void> }) {
  const [draft, setDraft] = useState<ProviderDraft>(() => draftFor(connection?.provider ?? "openai", connection));
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<ByokTestResult | undefined>(connection?.lastTest);
  const definition = providerDefinition(draft.provider);
  const models = useMemo(() => normalizeModels(draft.modelsText.split(/[\n,]/)), [draft.modelsText]);

  const patch = (value: Partial<ProviderDraft>, resetTest = true) => {
    setDraft((current) => ({ ...current, ...value }));
    if (resetTest) setTestResult(undefined);
  };

  const changeProvider = (provider: ByokProviderId) => {
    if (connection) {
      patch({ provider });
      return;
    }
    setDraft(draftFor(provider));
    setTestResult(undefined);
  };

  const effectiveKey = () => draft.apiKey || connection?.apiKey || "";
  const effectiveBaseUrl = () => normalizeBaseUrl(draft.baseUrl, draft.provider);

  const test = async () => {
    if (!effectiveKey()) {
      setTestResult({ status: "failed", checkedAt: Date.now(), message: "Enter an API key before testing." });
      return;
    }
    setTesting(true);
    setTestResult(undefined);
    try {
      const response = await fetch("/api/byok/models", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await controlAuthHeaders()) },
        body: JSON.stringify({ connection: { provider: draft.provider, baseUrl: effectiveBaseUrl(), apiKey: effectiveKey() } }),
      });
      const body = (await response.json()) as { ok?: boolean; models?: string[]; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error ?? `Connection test failed (HTTP ${response.status}).`);
      const discovered = body.models ?? [];
      setTestResult({ status: "verified", checkedAt: Date.now(), message: `Provider responded successfully${discovered.length ? ` with ${discovered.length} models` : ""}.`, modelCount: discovered.length });
      if (discovered.length > 0) {
        const nextModels = normalizeModels([...discovered, ...models]);
        setDraft((current) => ({
          ...current,
          modelsText: nextModels.join("\n"),
          defaultModel: nextModels.includes(current.defaultModel) ? current.defaultModel : nextModels[0],
        }));
      }
      toast("Provider connection verified.");
    } catch (error) {
      setTestResult({ status: "failed", checkedAt: Date.now(), message: error instanceof Error ? error.message : "Connection test failed." });
    } finally {
      setTesting(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const defaultModel = draft.defaultModel.trim() || models[0] || "";
    if (!effectiveKey() || !defaultModel) {
      setTestResult({ status: "failed", checkedAt: Date.now(), message: "An API key and at least one model ID are required." });
      return;
    }
    setSaving(true);
    try {
      const input = {
        provider: draft.provider,
        name: draft.name.trim() || definition.name,
        baseUrl: effectiveBaseUrl(),
        apiKey: effectiveKey(),
        models: normalizeModels([defaultModel, ...models]),
        defaultModel,
        enabled: draft.enabled,
        lastTest: testResult,
      };
      const saved = connection ? await ByokStore.update(connection.id, input) : await ByokStore.create(input);
      await onSaved(saved);
      toast(testResult?.status === "verified" ? "Verified provider saved." : "Provider saved locally; connection not verified.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save provider.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void save(event)} className="rounded-2xl border border-line-strong bg-ink-850/70 p-4 sm:p-5" data-testid="provider-editor">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-fog-100">{connection ? `Edit ${connection.name}` : "Add a personal provider"}</h4>
          <p className="mt-1 text-xs text-fog-500">Save first, or test the entered credentials before saving.</p>
        </div>
        <button type="button" onClick={onCancel} className="rounded-lg p-1.5 text-fog-500 hover:bg-ink-800 hover:text-fog-200" aria-label="Cancel provider editing"><Icon name="x" size={17} /></button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label>
          <span className={labelClass}>Provider connector</span>
          <select value={draft.provider} disabled={Boolean(connection)} onChange={(event) => changeProvider(event.target.value as ByokProviderId)} className={inputClass} aria-label="Provider connector">
            {BYOK_PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
          </select>
        </label>
        <label>
          <span className={labelClass}>Display name</span>
          <input value={draft.name} onChange={(event) => patch({ name: event.target.value }, false)} maxLength={80} className={inputClass} placeholder="My provider" aria-label="Provider display name" />
        </label>
      </div>
      <p className="mt-2 text-xs leading-5 text-fog-500">{definition.description}{definition.docsUrl ? <> <a href={definition.docsUrl} target="_blank" rel="noreferrer" className="text-ember-400 hover:underline">Get an API key ↗</a></> : null}</p>

      <label className="mt-4 block">
        <span className={labelClass}>API base URL</span>
        <input value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} disabled={draft.provider !== "custom"} className={cn(inputClass, "font-mono text-xs disabled:opacity-60")} placeholder="https://provider.example.com/v1" aria-label="API base URL" />
        <span className="mt-1.5 block text-[11px] leading-4 text-fog-600">{draft.provider === "custom" ? "Public HTTPS only. The endpoint must implement GET /models and POST /chat/completions." : "Managed by the selected connector. Use Custom for a different endpoint."}</span>
      </label>

      <label className="mt-4 block">
        <span className={labelClass}>API key</span>
        <span className="relative block">
          <input type={showKey ? "text" : "password"} value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} autoComplete="off" spellCheck={false} className={cn(inputClass, "pr-16 font-mono")} placeholder={connection ? "Leave blank to keep the saved key" : "Paste your API key"} aria-label="API key" />
          <button type="button" onClick={() => setShowKey((value) => !value)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-[10px] font-medium text-fog-500 hover:bg-ink-800 hover:text-fog-200">{showKey ? "Hide" : "Show"}</button>
        </span>
      </label>

      <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_220px]">
        <label>
          <span className={labelClass}>Model IDs <span className="font-normal text-fog-600">(one per line)</span></span>
          <textarea value={draft.modelsText} onChange={(event) => patch({ modelsText: event.target.value }, false)} rows={6} className="w-full resize-y rounded-xl border border-line bg-ink-900 p-3 font-mono text-xs leading-5 text-fog-200 outline-none placeholder:text-fog-600 focus:border-ember-400/40" placeholder="model-id" aria-label="Model IDs" />
        </label>
        <div>
          <label>
            <span className={labelClass}>Default model</span>
            <input list="byok-model-options" value={draft.defaultModel} onChange={(event) => patch({ defaultModel: event.target.value }, false)} className={cn(inputClass, "font-mono text-xs")} aria-label="Default model" />
            <datalist id="byok-model-options">{models.map((model) => <option key={model} value={model} />)}</datalist>
          </label>
          <div className="mt-4 flex items-center justify-between rounded-xl border border-line px-3 py-3">
            <span className="text-xs text-fog-400">Enabled</span>
            <Switch checked={draft.enabled} onChange={(enabled) => patch({ enabled }, false)} label="Provider enabled" />
          </div>
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-4 text-fog-600">Suggested IDs are configuration hints, not proof of availability. Test the connection to replace or extend the list with provider-reported models.</p>

      {testResult ? (
        <div className={cn("mt-4 rounded-xl border p-3 text-xs leading-5", testResult.status === "verified" ? "border-ok-400/20 bg-ok-400/[0.06] text-ok-400" : "border-danger-400/20 bg-danger-400/[0.06] text-danger-400")} role="status" data-testid="provider-test-result">
          <span className="font-semibold">{testResult.status === "verified" ? "Connection verified" : "Connection not verified"}</span>
          <p className="mt-0.5">{testResult.message}</p>
        </div>
      ) : null}

      <div className="mt-5 flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
        <button type="button" onClick={onCancel} className="h-10 rounded-xl border border-line px-4 text-xs font-medium text-fog-400 hover:bg-ink-800">Cancel</button>
        <button type="button" disabled={testing || saving} onClick={() => void test()} className="flex h-10 items-center justify-center gap-2 rounded-xl border border-ember-400/25 px-4 text-xs font-semibold text-ember-300 hover:bg-ember-400/10 disabled:opacity-50" data-testid="test-provider">
          <Icon name="refresh" size={14} className={testing ? "animate-spin" : undefined} />{testing ? "Testing…" : "Test & discover models"}
        </button>
        <button type="submit" disabled={saving || testing} className="h-10 rounded-xl bg-ember-400 px-5 text-xs font-semibold text-ink-950 hover:bg-ember-300 disabled:opacity-50" data-testid="save-provider">{saving ? "Saving…" : connection ? "Save changes" : "Save provider"}</button>
      </div>
    </form>
  );
}

function AppearanceSettings({ settings, onUpdate }: { settings: Settings; onUpdate: (patch: Partial<Settings>) => void }) {
  return (
    <SettingsGroup title="Workspace appearance" description="These preferences apply immediately and persist on this device.">
      <SettingRow title="Compact layout" description="Reduces message and composer spacing to fit more content on screen.">
        <Switch checked={settings.compactMode} onChange={(compactMode) => onUpdate({ compactMode })} label="Compact layout" />
      </SettingRow>
      <SettingRow title="Reduce motion" description="Disables nonessential interface animation and transitions.">
        <Switch checked={settings.reduceMotion} onChange={(reduceMotion) => onUpdate({ reduceMotion })} label="Reduce motion" />
      </SettingRow>
      <div className="px-4 py-4 sm:px-5">
        <p className="text-[13px] font-medium text-fog-200">Theme</p>
        <p className="mt-1 text-xs leading-5 text-fog-500">Aether currently uses its purpose-built dark workspace theme. No inactive light-theme control is shown.</p>
      </div>
    </SettingsGroup>
  );
}

function DataSettings({ online, busy, onExport, onWipe, onUpdate }: { online: boolean; busy: boolean; onExport: () => void | Promise<void>; onWipe: () => void | Promise<void>; onUpdate: (patch: Partial<Settings>) => void }) {
  const [stats, setStats] = useState<WorkspaceStats | null>(null);
  const [working, setWorking] = useState(false);
  const { connections, refresh } = useByokConnections();
  const load = async () => setStats(await workspaceStats());
  useEffect(() => { void load(); }, []);

  const exportData = async () => {
    setWorking(true);
    try { await onExport(); } finally { setWorking(false); }
  };
  const wipe = async () => {
    if (!window.confirm("Permanently erase conversations, files, tasks, memory, settings, and all saved provider keys from this browser?")) return;
    setWorking(true);
    try {
      await onWipe();
      announceByokChanged();
      await refresh();
      await load();
      toast("Local workspace erased.");
    } finally { setWorking(false); }
  };
  const clearKeys = async () => {
    if (!window.confirm("Remove every saved personal provider and API key from this browser?")) return;
    await ByokStore.clear();
    onUpdate({ model: { kind: "aether" } });
    announceByokChanged();
    await refresh();
    toast("Personal providers and keys removed.");
  };

  return (
    <>
      <SettingsGroup title="Local workspace" description={`${stats ? `${stats.conversations} conversations · ${stats.files} files · ${stats.assets} generated assets` : "Loading local storage summary…"}`}>
        <SettingRow title="Export workspace" description="Download conversations, projects, tasks, memory, settings, and file metadata. Binary files and BYOK provider records are excluded.">
          <button type="button" disabled={working} onClick={() => void exportData()} className="flex h-9 items-center gap-2 rounded-lg border border-line px-3 text-xs font-medium text-fog-300 hover:bg-ink-800 disabled:opacity-50"><Icon name="download" size={14} /> Export JSON</button>
        </SettingRow>
        <SettingRow title="Remove personal providers" description={`Delete ${connections.length} saved provider record${connections.length === 1 ? "" : "s"} and their local API keys. Workspace conversations remain.`}>
          <button type="button" disabled={connections.length === 0} onClick={() => void clearKeys()} className="h-9 rounded-lg border border-danger-400/20 px-3 text-xs font-medium text-danger-400 hover:bg-danger-400/10 disabled:opacity-40">Remove keys</button>
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Privacy and storage" description="Understand what is local and what leaves your device.">
        <div className="space-y-3 px-4 py-4 text-xs leading-5 text-fog-500 sm:px-5">
          <p><span className="font-medium text-fog-300">Workspace data:</span> stored in this browser’s IndexedDB. Aether does not provide per-user cloud workspace syncing.</p>
          <p><span className="font-medium text-fog-300">Personal keys:</span> saved locally only, excluded from workspace exports, and sent with the specific provider test or chat request. They transit the Aether server proxy and the selected provider.</p>
          <p><span className="font-medium text-fog-300">Not a secure vault:</span> local keys are not encrypted by Aether. Use a restricted key, provider spend limits, and a trusted browser profile.</p>
          <p><span className="font-medium text-fog-300">Network status:</span> {online ? "browser online" : "browser offline"}. This does not assert that any model provider is reachable.</p>
        </div>
      </SettingsGroup>
      <section className="rounded-2xl border border-danger-400/20 bg-danger-400/[0.035] p-4 sm:p-5">
        <h4 className="text-[13px] font-semibold text-danger-400">Erase local workspace</h4>
        <p className="mt-1 text-xs leading-5 text-fog-500">Permanently removes local conversations, files, tasks, memory, settings, and provider keys. This cannot be undone.</p>
        <button type="button" disabled={working || busy} onClick={() => void wipe()} className="mt-4 h-9 rounded-lg border border-danger-400/30 px-3 text-xs font-semibold text-danger-400 hover:bg-danger-400/10 disabled:opacity-40">{busy ? "Wait for the active reply" : working ? "Working…" : "Erase all local data"}</button>
      </section>
    </>
  );
}
