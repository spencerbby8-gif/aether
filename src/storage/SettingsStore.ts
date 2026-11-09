import { DEFAULT_SETTINGS, type ModelSelection, type Settings } from "@/lib/types";
import { STORES, idbGet, idbPut } from "./db";

const SETTINGS_KEY = "app-settings";

function validModel(value: unknown): value is ModelSelection {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<ModelSelection>;
  if (model.kind === "aether") return true;
  return (
    model.kind === "byok" &&
    typeof (model as { connectionId?: unknown }).connectionId === "string" &&
    typeof (model as { model?: unknown }).model === "string" &&
    (model as { model: string }).model.length > 0
  );
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function normalizeSettings(stored: Partial<Settings> | undefined): Settings {
  const value = stored ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    /* Individual fleet slots are no longer a public routing choice. */
    provider: "auto",
    model: validModel(value.model) ? value.model : DEFAULT_SETTINGS.model,
    streaming: typeof value.streaming === "boolean" ? value.streaming : DEFAULT_SETTINGS.streaming,
    reduceMotion: typeof value.reduceMotion === "boolean" ? value.reduceMotion : DEFAULT_SETTINGS.reduceMotion,
    compactMode: typeof value.compactMode === "boolean" ? value.compactMode : DEFAULT_SETTINGS.compactMode,
    sendOnEnter: typeof value.sendOnEnter === "boolean" ? value.sendOnEnter : DEFAULT_SETTINGS.sendOnEnter,
    systemPrompt: typeof value.systemPrompt === "string" ? value.systemPrompt.slice(0, 8_000) : "",
    temperature: boundedNumber(value.temperature, DEFAULT_SETTINGS.temperature, 0, 2),
    maxTokens: Math.round(boundedNumber(value.maxTokens, DEFAULT_SETTINGS.maxTokens, 1, 32_768)),
    requestTimeoutMs: Math.round(boundedNumber(value.requestTimeoutMs, DEFAULT_SETTINGS.requestTimeoutMs, 10_000, 180_000)),
  };
}

/** Persistence for user preferences. */
export const SettingsStore = {
  async get(): Promise<Settings> {
    try {
      return normalizeSettings(await idbGet<Partial<Settings>>(STORES.settings, SETTINGS_KEY));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  },

  async update(patch: Partial<Settings>): Promise<Settings> {
    const next = normalizeSettings({ ...(await this.get()), ...patch });
    await idbPut(STORES.settings, next, SETTINGS_KEY);
    return next;
  },
};
