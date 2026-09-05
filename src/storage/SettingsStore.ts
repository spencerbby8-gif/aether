import { DEFAULT_SETTINGS, normalizeRouting, type Settings } from "@/lib/types";
import { STORES, idbGet, idbPut } from "./db";

const SETTINGS_KEY = "app-settings";

/** Persistence for user preferences. */
export const SettingsStore = {
  async get(): Promise<Settings> {
    try {
      const stored = await idbGet<Partial<Settings>>(STORES.settings, SETTINGS_KEY);
      const merged = { ...DEFAULT_SETTINGS, ...stored };
      /* Legacy Phase 1–4 provider values migrate to the routing modes. */
      merged.provider = normalizeRouting(merged.provider);
      return merged;
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  },

  async update(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.get()), ...patch };
    await idbPut(STORES.settings, next, SETTINGS_KEY);
    return next;
  },
};
