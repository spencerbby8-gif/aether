import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CONTEXT_CHARS,
  RECENT_WINDOW,
  SUMMARIZE_AFTER,
  assembleContext,
  digestText,
  maybeRollSummary,
} from "@/agent/context";
import { ScriptedModel } from "./helpers";
import { ConversationStore, MemoryStore, ProjectStore } from "@/storage";
import { STORES, idbClear } from "@/storage/db";
import type { Message } from "@/lib/types";
import { uid } from "@/lib/utils";

async function clearAll() {
  await idbClear(STORES.conversations);
  await idbClear(STORES.messages);
  await idbClear(STORES.projects);
  await idbClear(STORES.tasks);
  await idbClear(STORES.memory);
  await idbClear(STORES.files);
}

function makeMessage(conversationId: string, role: "user" | "assistant", content: string, createdAt: number): Message {
  return { id: uid(), conversationId, role, content, status: "complete", createdAt, updatedAt: createdAt };
}

describe("ContextManager", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("assembles recent turns, memory, project instructions and related history", async () => {
    const project = await ProjectStore.create("Apollo");
    await ProjectStore.updateInstructions(project.id, "Always cite sources.");

    const current = await ConversationStore.create({ title: "Current", projectId: project.id });
    const other = await ConversationStore.create({ title: "Budget review", projectId: null });
    const base = Date.now() - 100_000;
    await ConversationStore.saveMessage(makeMessage(current.id, "user", "Tell me about the budget plan", base));
    await ConversationStore.saveMessage(makeMessage(current.id, "assistant", "Here is the budget plan…", base + 1));
    await ConversationStore.saveMessage(makeMessage(other.id, "user", "budget plan details from last week", base + 2));

    await MemoryStore.add({ scope: "fact", content: "The budget plan resets every quarter." });
    await MemoryStore.add({ scope: "fact", content: "Unrelated fact about penguins." });

    const pack = await assembleContext({
      conversationId: current.id,
      projectId: project.id,
      goal: "budget plan",
    });

    expect(pack.recent).toHaveLength(2);
    expect(pack.projectInstructions).toBe("Always cite sources.");
    expect(pack.memory.some((m) => m.content.includes("resets every quarter"))).toBe(true);
    expect(pack.memory.some((m) => m.content.includes("penguins"))).toBe(false);
    expect(pack.relevantHistory.some((h) => h.title === "Budget review")).toBe(true);
    expect(pack.relevantHistory.every((h) => h.title !== "Current")).toBe(true);

    const digest = digestText(pack);
    expect(digest).toContain("Project instructions");
    expect(digest).toContain("resets every quarter");
    expect(digest.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
  });

  it("caps the recent window and includes the rolling summary", async () => {
    const conversation = await ConversationStore.create({ title: "Long one", projectId: null });
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < RECENT_WINDOW + 6; i += 1) {
      await ConversationStore.saveMessage(
        makeMessage(conversation.id, i % 2 === 0 ? "user" : "assistant", `turn ${i}`, base + i * 1000),
      );
    }
    await ConversationStore.patch(conversation.id, { summary: "Earlier talk about launch plans.", summarizedAt: base });

    const pack = await assembleContext({ conversationId: conversation.id, projectId: null, goal: "launch" });
    expect(pack.recent.length).toBe(RECENT_WINDOW);
    expect(pack.summary).toBe("Earlier talk about launch plans.");
    expect(digestText(pack)).toContain("Earlier talk about launch plans");
  });

  it("trims material to stay within budget", async () => {
    const conversation = await ConversationStore.create({ title: "Tight budget", projectId: null });
    await ConversationStore.saveMessage(makeMessage(conversation.id, "user", "budget topic", Date.now()));
    for (let i = 0; i < 6; i += 1) {
      await MemoryStore.add({ scope: "fact", content: `Budget memory entry number ${i} with budget keywords budget.` });
    }
    const pack = await assembleContext({
      conversationId: conversation.id,
      projectId: null,
      goal: "budget",
      maxChars: 300,
    });
    expect(digestText(pack).length).toBeLessThanOrEqual(300);
  });

  it("rolls the conversation summary once enough history accumulates", async () => {
    const conversation = await ConversationStore.create({ title: "Rolling", projectId: null });
    const base = Date.now() - 1_000_000;
    const total = RECENT_WINDOW + SUMMARIZE_AFTER + 2;
    for (let i = 0; i < total; i += 1) {
      await ConversationStore.saveMessage(
        makeMessage(conversation.id, i % 2 === 0 ? "user" : "assistant", `message ${i}`, base + i * 1000),
      );
    }

    const model = new ScriptedModel();
    const rolled = await maybeRollSummary(conversation.id, model);
    expect(rolled).toBe(true);
    expect(model.summarizeCalls).toBe(1);

    const updated = await ConversationStore.get(conversation.id);
    expect(updated?.summary).toContain("Summary of");
    expect(updated?.summarizedAt).toBeGreaterThan(base);

    /* A second pass immediately after finds nothing new to fold in. */
    const again = await maybeRollSummary(conversation.id, model);
    expect(again).toBe(false);
  });

  it("preserves recent messages intact through a long conversation (no silent discard)", async () => {
    const conversation = await ConversationStore.create({ title: "Long context", projectId: null });
    const base = Date.now() - 2_000_000;
    /* Build a long conversation: many older messages + a distinctive recent one. */
    const total = RECENT_WINDOW + SUMMARIZE_AFTER + 10;
    for (let i = 0; i < total; i += 1) {
      await ConversationStore.saveMessage(
        makeMessage(conversation.id, i % 2 === 0 ? "user" : "assistant", `older message ${i}`, base + i * 1000),
      );
    }
    const distinctive = "UNIQUE-RECENT-REQUEST-XYZ";
    await ConversationStore.saveMessage(makeMessage(conversation.id, "user", distinctive, Date.now()));

    /* Roll older history into a summary. */
    const model = new ScriptedModel();
    await maybeRollSummary(conversation.id, model);

    /* Assemble context: the recent window must still contain the distinctive
       recent message — it must not be silently dropped by compaction. */
    const pack = await assembleContext({ conversationId: conversation.id, projectId: null, goal: "continue" });
    const recentText = pack.recent.map((t) => t.content).join(" ");
    expect(recentText).toContain(distinctive);
    /* Recent window is bounded. */
    expect(pack.recent.length).toBeLessThanOrEqual(RECENT_WINDOW);
    /* A summary exists for the older history. */
    expect(pack.summary).toBeTruthy();
  });

  it("keeps context within the budget without dropping recent messages", async () => {
    const conversation = await ConversationStore.create({ title: "Budget", projectId: null });
    const base = Date.now() - 3_000_000;
    for (let i = 0; i < RECENT_WINDOW + SUMMARIZE_AFTER + 5; i += 1) {
      await ConversationStore.saveMessage(
        makeMessage(conversation.id, i % 2 === 0 ? "user" : "assistant", `filler message ${i}`, base + i * 1000),
      );
    }
    const key = "CRITICAL-RECENT-CONTEXT";
    await ConversationStore.saveMessage(makeMessage(conversation.id, "user", key, Date.now()));
    const model = new ScriptedModel();
    await maybeRollSummary(conversation.id, model);

    const pack = await assembleContext({ conversationId: conversation.id, projectId: null, goal: "go", maxChars: 1500 });
    expect(digestText(pack).length).toBeLessThanOrEqual(1500);
    /* Even under a tight budget, the recent critical message survives. */
    expect(pack.recent.map((t) => t.content).join(" ")).toContain(key);
  });
});
