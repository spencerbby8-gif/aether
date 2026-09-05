import type { Conversation, Project } from "@/lib/types";
import { uid } from "@/lib/utils";
import { STORES, idbDelete, idbGet, idbGetAll, idbPut } from "./db";
import { ConversationStore } from "./ConversationStore";

/** Persistence for projects (lightweight groupings of conversations). */
export const ProjectStore = {
  async list(): Promise<Project[]> {
    const all = await idbGetAll<Project>(STORES.projects);
    return all.sort((a, b) => a.createdAt - b.createdAt);
  },

  async create(name: string): Promise<Project> {
    const project: Project = { id: uid(), name: name.trim() || "Untitled project", createdAt: Date.now() };
    await idbPut(STORES.projects, project);
    return project;
  },

  async rename(id: string, name: string): Promise<void> {
    const existing = await idbGet<Project>(STORES.projects, id);
    if (!existing) return;
    await idbPut(STORES.projects, { ...existing, name: name.trim() || existing.name });
  },

  async updateInstructions(id: string, instructions: string): Promise<void> {
    const existing = await idbGet<Project>(STORES.projects, id);
    if (!existing) return;
    await idbPut(STORES.projects, { ...existing, instructions: instructions.trim() || undefined });
  },

  async remove(id: string): Promise<void> {
    const conversations = await idbGetAll<Conversation>(STORES.conversations);
    for (const conversation of conversations) {
      if (conversation.projectId === id) {
        await ConversationStore.patch(conversation.id, { projectId: null });
      }
    }
    await idbDelete(STORES.projects, id);
  },

  /** Map of projectId -> conversation count. */
  async counts(): Promise<Record<string, number>> {
    const conversations = await idbGetAll<Conversation>(STORES.conversations);
    const map: Record<string, number> = {};
    for (const conversation of conversations) {
      if (conversation.projectId) {
        map[conversation.projectId] = (map[conversation.projectId] ?? 0) + 1;
      }
    }
    return map;
  },
};
