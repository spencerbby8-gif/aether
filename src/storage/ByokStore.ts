import type { ByokConnection, ByokConnectionInput } from "@/lib/byok";
import { normalizeBaseUrl, normalizeModels } from "@/lib/byok";
import { uid } from "@/lib/utils";
import { STORES, idbGet, idbPut } from "./db";

const BYOK_KEY = "byok-connections-v1";

function validConnection(value: unknown): value is ByokConnection {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ByokConnection>;
  return (
    typeof item.id === "string" &&
    typeof item.provider === "string" &&
    typeof item.name === "string" &&
    typeof item.baseUrl === "string" &&
    typeof item.apiKey === "string" &&
    Array.isArray(item.models) &&
    item.models.every((model) => typeof model === "string") &&
    typeof item.defaultModel === "string" &&
    typeof item.enabled === "boolean"
  );
}

/** Browser-local BYOK persistence. Never include this record in exports. */
export const ByokStore = {
  async list(): Promise<ByokConnection[]> {
    try {
      const stored = await idbGet<unknown>(STORES.settings, BYOK_KEY);
      if (!Array.isArray(stored)) return [];
      return stored.filter(validConnection).sort((a, b) => a.createdAt - b.createdAt);
    } catch {
      return [];
    }
  },

  async get(id: string): Promise<ByokConnection | undefined> {
    return (await this.list()).find((connection) => connection.id === id);
  },

  async create(input: ByokConnectionInput): Promise<ByokConnection> {
    const now = Date.now();
    const models = normalizeModels(input.models);
    const connection: ByokConnection = {
      ...input,
      id: `byok_${uid()}`,
      name: input.name.trim(),
      baseUrl: normalizeBaseUrl(input.baseUrl, input.provider),
      models,
      defaultModel: input.defaultModel.trim() || models[0] || "",
      createdAt: now,
      updatedAt: now,
    };
    const connections = await this.list();
    await idbPut(STORES.settings, [...connections, connection], BYOK_KEY);
    return connection;
  },

  async update(id: string, patch: Partial<Omit<ByokConnection, "id" | "createdAt">>): Promise<ByokConnection> {
    const connections = await this.list();
    const index = connections.findIndex((connection) => connection.id === id);
    if (index < 0) throw new Error("Provider connection no longer exists.");
    const current = connections[index];
    const provider = patch.provider ?? current.provider;
    const models = normalizeModels(patch.models ?? current.models);
    const next: ByokConnection = {
      ...current,
      ...patch,
      id: current.id,
      provider,
      baseUrl: normalizeBaseUrl(patch.baseUrl ?? current.baseUrl, provider),
      models,
      defaultModel: (patch.defaultModel ?? current.defaultModel).trim() || models[0] || "",
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    };
    connections[index] = next;
    await idbPut(STORES.settings, connections, BYOK_KEY);
    return next;
  },

  async remove(id: string): Promise<void> {
    const connections = await this.list();
    await idbPut(STORES.settings, connections.filter((connection) => connection.id !== id), BYOK_KEY);
  },

  async clear(): Promise<void> {
    await idbPut(STORES.settings, [], BYOK_KEY);
  },
};
