import { describe, expect, it } from "vitest";

import { AgentRuntime } from "@/agent/runtime";
import type { AgentEvent, PlanStepSpec, RuntimeTask } from "@/lib/types";
import { sleep, uid } from "@/lib/utils";

import { ScriptedModel, makeContext, makeRegistry } from "../helpers";
import type { ToolExecutor } from "@/agent/tools";

/**
 * Does the TypeScript runtime actually overlap independent work?
 *
 * The scheduler's own functions are covered in task-graph.test.ts, but those are
 * pure and could be correct while the runtime still ran everything one at a
 * time. These tests measure real wall-clock overlap between tool executions.
 */

const windows = new Map<string, { start: number; end: number }>();

function slowTool(name: string, ms: number): ToolExecutor {
  return {
    schema: {
      name,
      description: `Sleeps ${ms}ms and records when it ran — test tool.`,
      parameters: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] },
    },
    async execute(args) {
      const tag = String(args.tag ?? name);
      const start = Date.now();
      await sleep(ms);
      windows.set(tag, { start, end: Date.now() });
      return `${name}:${tag}`;
    },
  };
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function makeTask(goal: string): RuntimeTask {
  const now = Date.now();
  return {
    id: uid(),
    conversationId: "conv-parallel",
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

function plan(specs: PlanStepSpec[], decisions: unknown[]) {
  return new ScriptedModel({ planSteps: specs, decisions: decisions as never });
}

describe("AgentRuntime — dependency scheduling", () => {
  it("runs independent parallel-safe steps at the same time", async () => {
    windows.clear();
    const model = plan(
      [
        { id: "s1", title: "Fetch source one", tool: "slow_a", parallelSafe: true },
        { id: "s2", title: "Fetch source two", tool: "slow_b", parallelSafe: true },
        { id: "s3", title: "Combine", tool: "slow_c", dependsOn: ["s1", "s2"] },
        { id: "s4", title: "Report", dependsOn: ["s3"] },
      ],
      [
        { type: "tool_call", tool: "slow_a", args: { tag: "s1" }, description: "Fetching one" },
        { type: "tool_call", tool: "slow_b", args: { tag: "s2" }, description: "Fetching two" },
        { type: "tool_call", tool: "slow_c", args: { tag: "s3" }, description: "Combining" },
        {
          type: "answer",
          text: "Combined both sources into a single verified result for the user.",
        },
      ],
    );

    const task = makeTask("Compare two sources");
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime(task, {
      model,
      tools: makeRegistry([slowTool("slow_a", 220), slowTool("slow_b", 220), slowTool("slow_c", 30)]),
      context: makeContext(task.goal),
      streaming: false,
      onEvent: (e) => events.push(e),
      onSnapshot: () => {},
    });
    const started = Date.now();
    const finished = await runtime.run();
    const elapsed = Date.now() - started;

    expect(finished.status).toBe("completed");
    expect(windows.has("s1") && windows.has("s2")).toBe(true);
    expect(overlaps(windows.get("s1")!, windows.get("s2")!)).toBe(true);
    /* If the two 220ms fetches had run one after the other the run would take at
       least 440ms of tool time; overlapping keeps it near one of them. */
    expect(elapsed).toBeLessThan(430);
    expect(windows.get("s3")!.start).toBeGreaterThanOrEqual(windows.get("s1")!.end);
    expect(windows.get("s3")!.start).toBeGreaterThanOrEqual(windows.get("s2")!.end);
    expect(finished.steps.map((s) => s.state)).toEqual(["done", "done", "done", "done"]);
  });

  it("never overlaps a step that is not marked parallel-safe", async () => {
    windows.clear();
    const model = plan(
      [
        { id: "w1", title: "Install dependencies", tool: "slow_a" },
        { id: "w2", title: "Write the file", tool: "slow_b" },
        { id: "w3", title: "Run the build", tool: "slow_c" },
      ],
      [
        { type: "tool_call", tool: "slow_a", args: { tag: "w1" }, description: "Installing" },
        { type: "tool_call", tool: "slow_b", args: { tag: "w2" }, description: "Writing" },
        { type: "tool_call", tool: "slow_c", args: { tag: "w3" }, description: "Building" },
      ],
    );

    const task = makeTask("Set up and build");
    const runtime = new AgentRuntime(task, {
      model,
      tools: makeRegistry([slowTool("slow_a", 120), slowTool("slow_b", 120), slowTool("slow_c", 120)]),
      context: makeContext(task.goal),
      streaming: false,
      onEvent: () => {},
      onSnapshot: () => {},
    });
    const finished = await runtime.run();

    expect(finished.status).toBe("completed");
    expect(overlaps(windows.get("w1")!, windows.get("w2")!)).toBe(false);
    expect(overlaps(windows.get("w2")!, windows.get("w3")!)).toBe(false);
    expect(windows.get("w2")!.start).toBeGreaterThanOrEqual(windows.get("w1")!.end);
  });

  it("skips the work downstream of a failed step instead of leaving it pending", async () => {
    windows.clear();
    const model = plan(
      [
        { id: "bad", title: "Fetch the unreachable source", tool: "always_bad", parallelSafe: true },
        { id: "needs", title: "Use that source", tool: "slow_c", dependsOn: ["bad"] },
      ],
      [
        { type: "tool_call", tool: "always_bad", args: {}, description: "Fetching" },
        { type: "tool_call", tool: "slow_c", args: { tag: "needs" }, description: "Using it" },
      ],
    );

    const failing: ToolExecutor = {
      schema: {
        name: "always_bad",
        description: "Always fails — test tool.",
        parameters: { type: "object", properties: {} },
      },
      async execute() {
        throw new Error("HTTP 403 from the source");
      },
    };

    const task = makeTask("Use a source that refuses us");
    const runtime = new AgentRuntime(task, {
      model,
      tools: makeRegistry([failing, slowTool("slow_c", 10)]),
      context: makeContext(task.goal),
      streaming: false,
      maxStepAttempts: 1,
      onEvent: () => {},
      onSnapshot: () => {},
    });

    const finished = await runtime.run();
    expect(finished.status).toBe("failed");
    expect(task.steps.find((s) => s.id === "bad")?.state).toBe("failed");
    expect(task.steps.find((s) => s.id === "needs")?.state).toBe("skipped");
    expect(windows.has("needs")).toBe(false);
  });

  it("falls back to written order when the plan contains a dependency loop", async () => {
    windows.clear();
    const model = plan(
      [
        { id: "x", title: "Step X", tool: "slow_a", dependsOn: ["y"], parallelSafe: true },
        { id: "y", title: "Step Y", tool: "slow_b", dependsOn: ["x"], parallelSafe: true },
      ],
      [
        { type: "tool_call", tool: "slow_a", args: { tag: "x" }, description: "X" },
        { type: "tool_call", tool: "slow_b", args: { tag: "y" }, description: "Y" },
      ],
    );

    const task = makeTask("A plan the model got wrong");
    const runtime = new AgentRuntime(task, {
      model,
      tools: makeRegistry([slowTool("slow_a", 20), slowTool("slow_b", 20)]),
      context: makeContext(task.goal),
      streaming: false,
      onEvent: () => {},
      onSnapshot: () => {},
    });
    const finished = await runtime.run();

    /* A loop has no runnable step at all, so without the fallback this would
       deadlock before doing anything. */
    expect(finished.steps.map((s) => s.state)).toEqual(["done", "done"]);
    expect(windows.has("x") && windows.has("y")).toBe(true);
  });
});
