import type { MemoryEntry, MemoryScope } from "@/lib/types";
import { scoreRelevance, truncate, uid } from "@/lib/utils";
import { STORES, idbClear, idbDelete, idbGetAll, idbGetAllByIndex, idbPut } from "./db";

/**
 * Local, inspectable agent memory.
 * Memory is curated — facts, decisions and user-approved preferences —
 * never a dump of every message.
 */
export const MemoryStore = {
  async add(input: { scope: MemoryScope; content: string; refId?: string | null }): Promise<MemoryEntry> {
    const now = Date.now();
    const entry: MemoryEntry = {
      id: uid(),
      scope: input.scope,
      content: truncate(input.content, 480),
      refId: input.refId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await idbPut(STORES.memory, entry);
    return entry;
  },

  async list(): Promise<MemoryEntry[]> {
    const all = await idbGetAll<MemoryEntry>(STORES.memory);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async byScope(scope: MemoryScope): Promise<MemoryEntry[]> {
    const entries = await idbGetAllByIndex<MemoryEntry>(STORES.memory, "byScope", scope);
    return entries.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async remove(id: string): Promise<void> {
    await idbDelete(STORES.memory, id);
  },

  async clear(): Promise<void> {
    await idbClear(STORES.memory);
  },

  /** Keyword-relevance lookup used by the ContextManager and tools. */
  async relevant(query: string, limit = 4): Promise<MemoryEntry[]> {
    const all = await this.list();
    return all
      .map((entry) => ({ entry, score: scoreRelevance(query, entry.content) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.entry);
  },
};
