import type { Conversation, Message, SearchResult } from "@/lib/types";
import { truncate, uid } from "@/lib/utils";
import { STORES, idbDelete, idbGet, idbGetAll, idbGetAllByIndex, idbPut } from "./db";

/** Persistence for conversations and their messages. */
export const ConversationStore = {
  async list(): Promise<Conversation[]> {
    const all = await idbGetAll<Conversation>(STORES.conversations);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async get(id: string): Promise<Conversation | undefined> {
    return idbGet<Conversation>(STORES.conversations, id);
  },

  async create(input: { title: string; projectId: string | null }): Promise<Conversation> {
    const now = Date.now();
    const conversation: Conversation = {
      id: uid(),
      title: truncate(input.title, 64) || "New conversation",
      projectId: input.projectId,
      createdAt: now,
      updatedAt: now,
    };
    await idbPut(STORES.conversations, conversation);
    return conversation;
  },

  async patch(
    id: string,
    patch: Partial<Pick<Conversation, "title" | "projectId" | "updatedAt" | "summary" | "summarizedAt">>,
  ): Promise<void> {
    const existing = await idbGet<Conversation>(STORES.conversations, id);
    if (!existing) return;
    await idbPut(STORES.conversations, { ...existing, ...patch });
  },

  async touch(id: string): Promise<void> {
    await this.patch(id, { updatedAt: Date.now() });
  },

  async remove(id: string): Promise<void> {
    const messages = await idbGetAllByIndex<Message>(STORES.messages, "byConversation", id);
    for (const message of messages) {
      await idbDelete(STORES.messages, message.id);
    }
    await idbDelete(STORES.conversations, id);
  },

  async messagesOf(conversationId: string): Promise<Message[]> {
    const messages = await idbGetAllByIndex<Message>(STORES.messages, "byConversation", conversationId);
    return messages.sort((a, b) => a.createdAt - b.createdAt);
  },

  async saveMessage(message: Message): Promise<void> {
    await idbPut(STORES.messages, message);
  },

  async deleteMessage(id: string): Promise<void> {
    await idbDelete(STORES.messages, id);
  },

  async clearMessages(conversationId: string): Promise<void> {
    const messages = await idbGetAllByIndex<Message>(STORES.messages, "byConversation", conversationId);
    for (const message of messages) {
      await idbDelete(STORES.messages, message.id);
    }
  },

  async search(query: string, limit = 12): Promise<SearchResult[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const [conversations, messages] = await Promise.all([
      idbGetAll<Conversation>(STORES.conversations),
      idbGetAll<Message>(STORES.messages),
    ]);
    const results: SearchResult[] = [];
    const sorted = conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const conversation of sorted) {
      if (results.length >= limit) break;
      if (conversation.title.toLowerCase().includes(q)) {
        results.push({ conversation, snippet: conversation.title });
        continue;
      }
      const hit = messages.find(
        (m) => m.conversationId === conversation.id && m.content.toLowerCase().includes(q),
      );
      if (hit) {
        const idx = hit.content.toLowerCase().indexOf(q);
        const start = Math.max(0, idx - 34);
        results.push({
          conversation,
          snippet: `${start > 0 ? "…" : ""}${hit.content.slice(start, start + 110).replace(/\s+/g, " ").trim()}`,
        });
      }
    }
    return results;
  },
};
