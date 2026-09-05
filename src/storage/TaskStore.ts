import type { RuntimeTask, TaskStatus } from "@/lib/types";
import { truncate, uid } from "@/lib/utils";
import { STORES, idbClear, idbDelete, idbGet, idbGetAll, idbGetAllByIndex, idbPut } from "./db";

/** In-flight statuses that must be recovered after a reload. */
const IN_FLIGHT: TaskStatus[] = ["planning", "running", "waiting_approval", "validating"];

/* Monotonic high-water mark so tasks created/saved within the same
   millisecond still sort deterministically (updatedAt descending). */
let lastTs = 0;
function nextTs(): number {
  const now = Date.now();
  lastTs = now > lastTs ? now : lastTs + 1;
  return lastTs;
}

/** Persistence for agent tasks/runs and their full execution history. */
export const TaskStore = {
  async create(input: {
    conversationId: string;
    projectId: string | null;
    goal: string;
    mode?: "task" | "chat";
  }): Promise<RuntimeTask> {
    const now = nextTs();
    const task: RuntimeTask = {
      id: uid(),
      conversationId: input.conversationId,
      projectId: input.projectId,
      goal: truncate(input.goal, 280),
      mode: input.mode ?? "task",
      status: "pending",
      steps: [],
      observations: [],
      approvals: [],
      events: [],
      createdAt: now,
      updatedAt: now,
    };
    await idbPut(STORES.tasks, task);
    return task;
  },

  async save(task: RuntimeTask): Promise<void> {
    await idbPut(STORES.tasks, { ...task, updatedAt: nextTs() });
  },

  async get(id: string): Promise<RuntimeTask | undefined> {
    return idbGet<RuntimeTask>(STORES.tasks, id);
  },

  async list(): Promise<RuntimeTask[]> {
    const all = await idbGetAll<RuntimeTask>(STORES.tasks);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async listForConversation(conversationId: string): Promise<RuntimeTask[]> {
    const tasks = await idbGetAllByIndex<RuntimeTask>(STORES.tasks, "byConversation", conversationId);
    return tasks.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async latestFor(conversationId: string): Promise<RuntimeTask | undefined> {
    const tasks = await this.listForConversation(conversationId);
    return tasks[0];
  },

  async remove(id: string): Promise<void> {
    await idbDelete(STORES.tasks, id);
  },

  async clear(): Promise<void> {
    await idbClear(STORES.tasks);
  },

  /**
   * Recovery: any task left in flight when the app closed becomes
   * "interrupted" so it can be inspected or resumed deliberately.
   */
  async markInterrupted(): Promise<number> {
    const all = await idbGetAll<RuntimeTask>(STORES.tasks);
    let count = 0;
    for (const task of all) {
      if (IN_FLIGHT.includes(task.status)) {
        await idbPut(STORES.tasks, {
          ...task,
          status: "interrupted",
          /* Steps killed mid-flight go back to pending so a resume can run them. */
          steps: task.steps.map((s) =>
            s.state === "running" ? { ...s, state: "pending" as const, attempts: 0, startedAt: undefined } : s,
          ),
          updatedAt: Date.now(),
          events: [...task.events, { at: Date.now(), text: "Interrupted — the app was closed mid-run. Resume from the Tasks panel." }],
        });
        count += 1;
      }
    }
    return count;
  },
};
