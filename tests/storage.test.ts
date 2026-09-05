import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, TaskStore } from "@/storage";
import { ConversationStore } from "@/storage/ConversationStore";
import { STORES, idbClear } from "@/storage/db";
import type { RuntimeTask } from "@/lib/types";

async function clearAll() {
  await idbClear(STORES.tasks);
  await idbClear(STORES.memory);
  await idbClear(STORES.conversations);
  await idbClear(STORES.messages);
}

describe("TaskStore", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("creates, persists and lists tasks", async () => {
    const task = await TaskStore.create({ conversationId: "c1", projectId: null, goal: "Ship the report" });
    expect(task.status).toBe("pending");
    expect(task.steps).toEqual([]);

    const updated: RuntimeTask = {
      ...task,
      status: "running",
      steps: [{ id: "s1", title: "Step one", state: "done", attempts: 1, result: "ok" }],
      events: [...task.events, { at: Date.now(), text: "Started" }],
    };
    await TaskStore.save(updated);

    const fetched = await TaskStore.get(task.id);
    expect(fetched?.status).toBe("running");
    expect(fetched?.steps[0].result).toBe("ok");

    const second = await TaskStore.create({ conversationId: "c1", projectId: null, goal: "Second task" });
    const list = await TaskStore.list();
    expect(list.length).toBe(2);
    expect(list[0].id).toBe(second.id);

    const latest = await TaskStore.latestFor("c1");
    expect(latest?.id).toBe(second.id);
  });

  it("recovers in-flight tasks as interrupted on boot", async () => {
    const running = await TaskStore.create({ conversationId: "c1", projectId: null, goal: "Running" });
    await TaskStore.save({ ...running, status: "running" });
    const waiting = await TaskStore.create({ conversationId: "c1", projectId: null, goal: "Waiting" });
    await TaskStore.save({ ...waiting, status: "waiting_approval" });
    const done = await TaskStore.create({ conversationId: "c1", projectId: null, goal: "Done" });
    await TaskStore.save({ ...done, status: "completed" });

    const count = await TaskStore.markInterrupted();
    expect(count).toBe(2);

    const list = await TaskStore.list();
    const byGoal = Object.fromEntries(list.map((t) => [t.goal, t.status]));
    expect(byGoal.Running).toBe("interrupted");
    expect(byGoal.Waiting).toBe("interrupted");
    expect(byGoal.Done).toBe("completed");
  });

  it("deletes tasks", async () => {
    const task = await TaskStore.create({ conversationId: "c1", projectId: null, goal: "Delete me" });
    await TaskStore.remove(task.id);
    expect(await TaskStore.get(task.id)).toBeUndefined();
  });
});

describe("MemoryStore", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("adds, scopes, lists and deletes entries", async () => {
    const fact = await MemoryStore.add({ scope: "fact", content: "Deploy window is Fridays." });
    const preference = await MemoryStore.add({ scope: "preference", content: "Prefers concise answers." });
    await MemoryStore.add({ scope: "task", content: "Task outcome recorded.", refId: "task-1" });

    expect((await MemoryStore.list()).length).toBe(3);
    expect((await MemoryStore.byScope("preference")).map((e) => e.id)).toEqual([preference.id]);

    await MemoryStore.remove(fact.id);
    const remaining = await MemoryStore.list();
    expect(remaining.length).toBe(2);
    expect(remaining.some((e) => e.id === fact.id)).toBe(false);
    expect(preference.content).toContain("concise");
  });

  it("ranks relevance lookups by keyword overlap", async () => {
    await MemoryStore.add({ scope: "fact", content: "The storage layer uses IndexedDB for persistence." });
    await MemoryStore.add({ scope: "fact", content: "Lunch is best at the noodle place." });
    await MemoryStore.add({ scope: "fact", content: "IndexedDB quotas vary by browser and storage pressure." });

    const hits = await MemoryStore.relevant("indexeddb storage", 2);
    expect(hits.length).toBe(2);
    expect(hits[0].content).toContain("IndexedDB");
    expect(hits.every((h) => !h.content.includes("noodle"))).toBe(true);
  });

  it("never stores message transcripts implicitly", async () => {
    /* Memory only grows through explicit writes — verify the store is empty
       after conversation activity elsewhere. */
    const conversation = await ConversationStore.create({ title: "Chatty", projectId: null });
    await ConversationStore.saveMessage({
      id: "m1",
      conversationId: conversation.id,
      role: "user",
      content: "A message that must never leak into memory.",
      status: "complete",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect((await MemoryStore.list()).length).toBe(0);
  });
});

describe("conversation summaries", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("persists rolling summary fields", async () => {
    const conversation = await ConversationStore.create({ title: "With summary", projectId: null });
    await ConversationStore.patch(conversation.id, { summary: "Covers storage decisions.", summarizedAt: 12345 });
    const fetched = await ConversationStore.get(conversation.id);
    expect(fetched?.summary).toBe("Covers storage decisions.");
    expect(fetched?.summarizedAt).toBe(12345);
  });
});
