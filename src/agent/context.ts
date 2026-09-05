import type { ChatTurn, ContextPack, MemoryEntry, RelevantHit } from "@/lib/types";
import { scoreRelevance, truncate } from "@/lib/utils";
import { AssetStore } from "@/storage/AssetStore";
import { ConversationStore, FileStore, MemoryStore, ProjectStore, TaskStore } from "@/storage";
import type { AgentModel } from "./model";

/**
 * ContextManager — assembles a focused context pack instead of blindly
 * replaying the whole conversation:
 *   recent messages + rolling summary + relevant history + project
 *   instructions + active task state + relevant files + curated memory.
 */

export const RECENT_WINDOW = 10;
export const SUMMARIZE_AFTER = 12;
export const MAX_CONTEXT_CHARS = 6000;

export async function assembleContext(options: {
  conversationId: string;
  projectId: string | null;
  goal: string;
  maxChars?: number;
}): Promise<ContextPack> {
  const { conversationId, projectId, goal, maxChars = MAX_CONTEXT_CHARS } = options;

  const [messages, conversation, projects, memory, files, latestTask, assets] = await Promise.all([
    ConversationStore.messagesOf(conversationId),
    ConversationStore.get(conversationId),
    ProjectStore.list(),
    MemoryStore.relevant(goal, 4),
    FileStore.list(),
    TaskStore.latestFor(conversationId),
    AssetStore.list().catch(() => [] as Array<{ name: string; kind: "image" | "video" | "audio" }>),
  ]);

  const recent: ChatTurn[] = messages.slice(-RECENT_WINDOW).map((m) => ({
    role: m.role,
    content:
      m.attachments && m.attachments.length > 0
        ? `${m.content}${m.content ? "\n" : ""}[attachments: ${m.attachments.map((a) => a.name).join(", ")}]`
        : m.content,
  }));

  const searchResults = goal.trim() ? await ConversationStore.search(goal, 8) : [];
  let relevantHistory: RelevantHit[] = searchResults
    .filter((r) => r.conversation.id !== conversationId)
    .slice(0, 4)
    .map((r) => ({
      source: "conversation",
      title: r.conversation.title,
      snippet: truncate(r.snippet, 160),
      score: scoreRelevance(goal, `${r.conversation.title} ${r.snippet}`),
    }));

  const project = projectId ? projects.find((p) => p.id === projectId) : undefined;

  let memoryHits: MemoryEntry[] = memory;

  let fileList = files
    .map((f) => ({ file: f, score: scoreRelevance(goal, f.name) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ file }) => ({ name: file.name, mimeType: file.mimeType, size: file.size }));

  let taskState: string | undefined;
  if (latestTask) {
    const done = latestTask.steps.filter((s) => s.state === "done").length;
    taskState = `Latest agent task "${truncate(latestTask.goal, 64)}" — status ${latestTask.status}, ${done}/${latestTask.steps.length} steps done.`;
  }

  const pack: ContextPack = {
    goal,
    projectInstructions: project?.instructions?.trim() || undefined,
    summary: conversation?.summary,
    recent,
    relevantHistory,
    memory: memoryHits,
    files: fileList,
    mediaAssets: assets.slice(0, 4).map((a) => ({ name: a.name, kind: a.kind })),
    taskState,
  };

  /* Trim lowest-value material until the digest fits the budget. */
  while (digestText(pack).length > maxChars) {
    if (pack.relevantHistory.length > 0) {
      pack.relevantHistory = pack.relevantHistory
        .sort((a, b) => a.score - b.score)
        .slice(1)
        .sort((a, b) => b.score - a.score);
    } else if (pack.memory.length > 0) {
      pack.memory = pack.memory.slice(1);
    } else if (pack.files.length > 0) {
      pack.files = pack.files.slice(1);
    } else if (pack.summary && pack.summary.length > 200) {
      pack.summary = truncate(pack.summary, 200);
    } else {
      break;
    }
  }

  return pack;
}

/** Compact, human-readable preamble derived from a context pack. */
export function digestText(pack: ContextPack): string {
  const lines: string[] = [];
  if (pack.projectInstructions) lines.push(`Project instructions: ${pack.projectInstructions}`);
  if (pack.summary) lines.push(`Conversation summary so far: ${pack.summary}`);
  if (pack.taskState) lines.push(pack.taskState);
  if (pack.memory.length > 0) {
    lines.push(`Relevant memory:\n${pack.memory.map((m) => `- [${m.scope}] ${m.content}`).join("\n")}`);
  }
  if (pack.relevantHistory.length > 0) {
    lines.push(
      `Related past conversations:\n${pack.relevantHistory.map((h) => `- "${h.title}": ${h.snippet}`).join("\n")}`,
    );
  }
  if (pack.files.length > 0) {
    lines.push(`Stored files: ${pack.files.map((f) => f.name).join(", ")}`);
  }
  if (pack.mediaAssets && pack.mediaAssets.length > 0) {
    lines.push(`Media assets: ${pack.mediaAssets.map((a) => `${a.name} (${a.kind})`).join(", ")}`);
  }
  return lines.join("\n\n");
}

/**
 * Rolling summaries: once enough un-summarized history accumulates behind
 * the recent window, fold it into the conversation's summary.
 * Returns true when a new summary was written.
 */
export async function maybeRollSummary(conversationId: string, model: AgentModel): Promise<boolean> {
  try {
    const [conversation, messages] = await Promise.all([
      ConversationStore.get(conversationId),
      ConversationStore.messagesOf(conversationId),
    ]);
    if (!conversation) return false;

    const keepRecent = Math.min(RECENT_WINDOW, messages.length);
    const older = messages.slice(0, messages.length - keepRecent);
    const summarizedAt = conversation.summarizedAt ?? 0;
    const fresh = older.filter((m) => m.createdAt > summarizedAt);
    if (fresh.length < SUMMARIZE_AFTER) return false;

    const texts = fresh.map((m) => `${m.role}: ${truncate(m.content, 140)}`);
    const part = await model.summarize(texts, new AbortController().signal);
    const merged = conversation.summary
      ? `${truncate(conversation.summary, 700)}\n${part}`
      : part;
    await ConversationStore.patch(conversation.id, {
      summary: truncate(merged, 1200),
      summarizedAt: fresh[fresh.length - 1].createdAt,
    });
    return true;
  } catch {
    /* Summarization is best-effort; it must never break a conversation. */
    return false;
  }
}
