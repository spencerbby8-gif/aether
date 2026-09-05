import { describe, expect, it } from "vitest";
import { AgentRuntime, type RuntimeOptions } from "@/agent/runtime";
import type { AgentEvent, RuntimeTask } from "@/lib/types";
import { sleep, uid } from "@/lib/utils";
import {
  ScriptedModel,
  alwaysFailingTool,
  approvalTool,
  echoTool,
  flakyTool,
  makeContext,
  makeRegistry,
  makeSteps,
} from "./helpers";

const ALLOWED_EVENT_TYPES = new Set([
  "status",
  "delta",
  "tool",
  "error",
  "done",
  "phase",
  "note",
  "plan",
  "step",
  "tool_call",
  "approval_request",
  "task_done",
]);

function makeTask(goal = "Test goal"): RuntimeTask {
  const now = Date.now();
  return {
    id: uid(),
    conversationId: "conv-1",
    projectId: null,
    goal,
    mode: "task",
    status: "pending",
    steps: [],
    observations: [],
    approvals: [],
    events: [],
    createdAt: now,
    updatedAt: now,
  };
}

interface Harness {
  runtime: AgentRuntime;
  events: AgentEvent[];
  snapshots: RuntimeTask[];
  run: Promise<RuntimeTask>;
}

function start(
  model: ScriptedModel,
  options: {
    tools?: Parameters<typeof makeRegistry>[0];
    task?: RuntimeTask;
    partial?: Partial<RuntimeOptions>;
  } = {},
): Harness {
  const events: AgentEvent[] = [];
  const snapshots: RuntimeTask[] = [];
  const task = options.task ?? makeTask();
  const runtime = new AgentRuntime(task, {
    model,
    tools: makeRegistry(options.tools ?? [echoTool]),
    context: makeContext(task.goal),
    streaming: false,
    onEvent: (event) => events.push(event),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    ...options.partial,
  });
  const run = runtime.run();
  return { runtime, events, snapshots, run };
}

describe("AgentRuntime — happy path", () => {
  it("plans, executes a tool, answers and completes", async () => {
    const model = new ScriptedModel({
      planSteps: makeSteps([{ title: "Gather context", tool: "echo" }, { title: "Compose result" }]),
      decisions: [
        { type: "tool_call", tool: "echo", args: { text: "hello" }, description: "Echoing" },
        { type: "answer", text: "Final answer — gathered context and composed the result successfully." },
      ],
    });
    const { events, run, snapshots } = start(model);
    const finished = await run;

    expect(finished.status).toBe("completed");
    expect(finished.steps.map((s) => s.state)).toEqual(["done", "done"]);
    expect(finished.output).toContain("Final answer");
    expect(finished.observations[0].text).toBe("echo:hello");
    expect(model.validateCalls).toBe(1);

    const phases = events.filter((e) => e.type === "phase").map((e) => (e as { phase: string }).phase);
    expect(phases).toContain("planning");
    expect(phases).toContain("executing");
    expect(phases).toContain("validating");
    expect(phases[phases.length - 1]).toBe("completed");
    expect(events.some((e) => e.type === "plan")).toBe(true);
    expect(events.some((e) => e.type === "tool_call")).toBe(true);
    expect(events.some((e) => e.type === "task_done")).toBe(true);
    expect(snapshots.at(-1)?.status).toBe("completed");
  });

  it("never exposes hidden chain-of-thought in events", async () => {
    const model = new ScriptedModel({
      planSteps: makeSteps([{ title: "Answer" }]),
      decisions: [{ type: "answer", text: "A safe, user-facing answer that is long enough to validate." }],
    });
    const { events, run } = start(model);
    await run;

    for (const event of events) {
      expect(ALLOWED_EVENT_TYPES.has(event.type)).toBe(true);
      const serialized = JSON.stringify(event).toLowerCase();
      expect(serialized).not.toContain('"thought"');
      expect(serialized).not.toContain('"cot"');
      expect(serialized).not.toContain('"reasoning"');
      expect(serialized).not.toContain('"internal"');
    }
  });
});

describe("AgentRuntime — state transitions & controls", () => {
  it("cancels a running task", async () => {
    const slowTool = {
      schema: { name: "slow", description: "slow", parameters: { type: "object" as const, properties: {} } },
      execute: (_args: Record<string, unknown>, _ctx: unknown, signal: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => resolve("slow-done"), 250);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    };
    const model = new ScriptedModel({
      planSteps: makeSteps([{ title: "Slow step", tool: "slow" }, { title: "Answer" }]),
      decisions: [{ type: "tool_call", tool: "slow", args: {} }],
    });
    const { runtime, run } = start(model, { tools: [slowTool] });
    await sleep(40);
    runtime.cancel();
    const finished = await run;
    expect(finished.status).toBe("cancelled");
    expect(finished.steps[0].state).not.toBe("done");
  });

  it("pauses before the next step and resumes to completion", async () => {
    const model = new ScriptedModel({
      planSteps: makeSteps([{ title: "Echo", tool: "echo" }, { title: "Answer" }]),
      decisions: [
        { type: "tool_call", tool: "echo", args: { text: "one" } },
        { type: "answer", text: "Answer after pause — completed normally with both steps executed." },
      ],
    });
    const { runtime, run } = start(model);
    runtime.pause();
    await sleep(40);
    expect(model.stepCalls).toBe(0);

    runtime.resume();
    const finished = await run;
    expect(finished.status).toBe("completed");
    expect(model.stepCalls).toBe(2);
  });

  it("blocks on approval and continues when approved", async () => {
    const model = new ScriptedModel({
      planSteps: makeSteps([{ title: "Sensitive step", tool: "needs-approval" }, { title: "Answer" }]),
      decisions: [
        { type: "tool_call", tool: "needs-approval", args: { text: "save it" } },
        { type: "answer", text: "Completed after the approved sensitive step ran with your consent." },
      ],
    });
    const { runtime, events, run } = start(model, { tools: [approvalTool] });

    await sleep(30);
    const request = events.find((e) => e.type === "approval_request") as
      | { requestId: string; tool: string }
      | undefined;
    expect(request).toBeDefined();
    expect(request?.tool).toBe("needs-approval");

    runtime.resolveApproval(request!.requestId, true);
    const finished = await run;
    expect(finished.status).toBe("completed");
    expect(finished.approvals[0].status).toBe("approved");
    expect(finished.observations[0].text).toBe("approved:save it");
  });

  it("marks the step declined when approval is refused and adapts", async () => {
    const model = new ScriptedModel({
      planSteps: makeSteps([{ title: "Sensitive step", tool: "needs-approval" }, { title: "Answer" }]),
      decisions: [
        { type: "tool_call", tool: "needs-approval", args: { text: "save it" } },
        { type: "answer", text: "Adapted after the declined step — produced a safe result without it." },
      ],
    });
    const { runtime, events, run } = start(model, { tools: [approvalTool] });
    await sleep(30);
    const request = events.find((e) => e.type === "approval_request") as { requestId: string };
    runtime.resolveApproval(request.requestId, false);
    const finished = await run;
    expect(finished.status).toBe("completed");
    expect(finished.steps[0].state).toBe("declined");
    expect(finished.approvals[0].status).toBe("declined");
  });
});

describe("AgentRuntime — recovery", () => {
  it("retries a failing tool until it succeeds", async () => {
    const toolCall = { type: "tool_call", tool: "flaky", args: {} } as const;
    const model = new ScriptedModel({
      planSteps: makeSteps([{ title: "Flaky step", tool: "flaky" }, { title: "Answer" }]),
      decisions: [
        /* One decision per attempt — the runtime re-decides on every retry. */
        { ...toolCall },
        { ...toolCall },
        { ...toolCall },
        { type: "answer", text: "Completed despite early flakiness — the retry logic recovered the step." },
      ],
    });
    const { run } = start(model, { tools: [flakyTool(2)] });
    const finished = await run;
    expect(finished.status).toBe("completed");
    expect(finished.steps[0].attempts).toBe(3);
    expect(finished.steps[0].result).toBe("flaky-ok");
  });

  it("fails the task after exhausting step attempts", async () => {
    const model = new ScriptedModel({
      planSteps: makeSteps([{ title: "Broken step", tool: "broken" }]),
      decisions: [
        { type: "tool_call", tool: "broken", args: {} },
        { type: "tool_call", tool: "broken", args: {} },
      ],
    });
    const { run } = start(model, { tools: [alwaysFailingTool], partial: { maxStepAttempts: 2 } });
    const finished = await run;
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("permanent failure");
    expect(finished.steps[0].state).toBe("failed");
  });

  it("recovers from an invalid tool call by asking the model to correct", async () => {
    const model = new ScriptedModel({
      planSteps: makeSteps([{ title: "Act", tool: "echo" }, { title: "Answer" }]),
      decisions: [
        { type: "tool_call", tool: "ghost-tool", args: {} },
        { type: "tool_call", tool: "echo", args: { text: "fixed" } },
        { type: "answer", text: "Recovered from an invalid tool call and completed the task properly." },
      ],
    });
    const { events, run } = start(model);
    const finished = await run;
    expect(finished.status).toBe("completed");
    expect(finished.observations[0].text).toBe("echo:fixed");
    const notes = events.filter((e) => e.type === "note").map((e) => (e as { text: string }).text);
    expect(notes.some((n) => n.includes("ghost-tool"))).toBe(true);
  });

  it("fails when the model times out and no fallback exists", async () => {
    const model = new ScriptedModel({
      planSteps: makeSteps([{ title: "Answer" }]),
      /* Both retry attempts hang → no fallback model → the task must fail. */
      decisions: ["hang", "hang"],
    });
    const { events, run } = start(model, { partial: { modelTimeoutMs: 40 } });
    const finished = await run;
    expect(finished.status).toBe("failed");
    const notes = events.filter((e) => e.type === "note").map((e) => (e as { text: string }).text);
    expect(notes.some((n) => n.toLowerCase().includes("timeout") || n.toLowerCase().includes("failed"))).toBe(true);
  });

  it("falls back to the secondary model when the primary keeps failing", async () => {
    const broken = new ScriptedModel({ planError: new Error("server exploded") });
    const fallback = new ScriptedModel({
      planSteps: makeSteps([{ title: "Answer" }]),
      decisions: [{ type: "answer", text: "Recovered via the on-device fallback model — task completed." }],
    });
    const events: AgentEvent[] = [];
    const task = makeTask();
    const runtime = new AgentRuntime(task, {
      model: broken,
      fallbackModel: fallback,
      tools: makeRegistry([]),
      context: makeContext(),
      streaming: false,
      onEvent: (event) => events.push(event),
      onSnapshot: () => {},
    });
    const finished = await runtime.run();
    expect(finished.status).toBe("completed");
    const notes = events.filter((e) => e.type === "note").map((e) => (e as { text: string }).text);
    expect(notes.some((n) => n.toLowerCase().includes("fallback"))).toBe(true);
  });

  it("persists failed steps so a retry can resume from them", async () => {
    const model = new ScriptedModel({
      planSteps: makeSteps([{ title: "Broken step", tool: "broken" }, { title: "Answer" }]),
      decisions: [
        { type: "tool_call", tool: "broken", args: {} },
        { type: "tool_call", tool: "broken", args: {} },
      ],
    });
    const first = start(model, { tools: [alwaysFailingTool], partial: { maxStepAttempts: 2 } });
    const failed = await first.run;
    expect(failed.status).toBe("failed");
    expect(failed.steps[0].state).toBe("failed");

    /* Simulate the UI retry: reset the failed step, keep the rest. */
    const resumed: RuntimeTask = {
      ...structuredClone(failed),
      status: "pending",
      error: undefined,
      finishedAt: undefined,
      steps: structuredClone(failed.steps).map((s) =>
        s.state === "failed" ? { ...s, state: "pending" as const, error: undefined, attempts: 0 } : s,
      ),
    };

    const retryModel = new ScriptedModel({
      decisions: [
        { type: "tool_call", tool: "echo", args: { text: "fixed" } },
        { type: "answer", text: "Recovered on the retry run — the failed step succeeded this time." },
      ],
    });
    const second = start(retryModel, { task: resumed, tools: [echoTool] });
    const finished = await second.run;
    expect(finished.status).toBe("completed");
    expect(finished.steps[0].state).toBe("done");
    expect(finished.steps[0].result).toBe("echo:fixed");
  });

  it("re-executes a step that was killed mid-flight (state=running)", async () => {
    const task = makeTask("Killed mid-step");
    task.steps = [
      { id: "s1", title: "Done earlier", state: "done", attempts: 1, result: "echo:done" },
      { id: "s2", title: "Killed while running", state: "running", attempts: 2 },
    ];
    const model = new ScriptedModel({
      decisions: [
        { type: "tool_call", tool: "echo", args: { text: "rerun" } },
        { type: "answer", text: "Recovered after the process was killed mid-step and finished cleanly." },
      ],
    });
    const { run } = start(model, { task });
    const finished = await run;
    expect(finished.status).toBe("completed");
    expect(finished.steps[1].state).toBe("done");
    expect(finished.steps[1].result).toBe("echo:rerun");
  });

  it("resumes a persisted task without re-planning", async () => {
    const task = makeTask("Resume me");
    task.steps = [
      { id: "s1", title: "Already done", state: "done", attempts: 1, result: "echo:done" },
      { id: "s2", title: "Compose result", state: "pending", attempts: 0 },
    ];
    const model = new ScriptedModel({
      decisions: [{ type: "answer", text: "Resumed from persisted state and completed without replanning." }],
    });
    const { run } = start(model, { task });
    const finished = await run;
    expect(finished.status).toBe("completed");
    expect(model.planCalls).toBe(0);
    expect(finished.steps[0].result).toBe("echo:done");
  });

  it("regenerates once when validation fails", async () => {
    const model = new ScriptedModel({
      planSteps: makeSteps([{ title: "Answer" }]),
      decisions: [
        { type: "answer", text: "First attempt answer — rejected by validation for being incomplete." },
        { type: "answer", text: "Regenerated answer — this one passes validation and completes the task." },
      ],
      validateResult: { ok: false, note: "too thin" },
    });
    const { events, run } = start(model);
    const finished = await run;
    expect(finished.status).toBe("completed");
    expect(model.validateCalls).toBe(2);
    const notes = events.filter((e) => e.type === "note").map((e) => (e as { text: string }).text);
    expect(notes.some((n) => n.includes("regenerating"))).toBe(true);
  });
});
