import { describe, expect, it } from "vitest";
import { brainAnswer, brainPlan, brainStep, brainSummarize, brainValidate, isTaskGoal } from "@/agent/brain";
import { createDefaultRegistry } from "@/agent/tools";
import type { ContextPack, TaskStep } from "@/lib/types";
import { makeContext } from "./helpers";

const TOOLS = createDefaultRegistry().schemas();

function stepOf(tool: string | undefined, title = "Step"): TaskStep {
  return { id: "s1", title, state: "pending", attempts: 0, tool };
}

function decide(goal: string, tool: string | undefined, overrides: Partial<Parameters<typeof brainStep>[0]> = {}) {
  const context: ContextPack = makeContext(goal);
  return brainStep({
    goal,
    context,
    steps: [stepOf(tool)],
    currentStep: stepOf(tool),
    observations: [],
    corrections: [],
    tools: TOOLS,
    ...overrides,
  });
}

describe("planning", () => {
  it("produces a multi-step plan with known tools for task-like goals", () => {
    const plan = brainPlan("Search previous conversations about the budget review and summarize them", TOOLS);
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    const toolSteps = plan.steps.filter((s) => s.tool);
    expect(toolSteps.length).toBeGreaterThanOrEqual(1);
    for (const step of toolSteps) {
      expect(TOOLS.map((t) => t.name)).toContain(step.tool);
    }
    /* The last step is always the answer step. */
    expect(plan.steps[plan.steps.length - 1].tool).toBeUndefined();
  });

  it("collapses simple questions into a single answer step", () => {
    const plan = brainPlan("What is the capital of France?", TOOLS);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].tool).toBeUndefined();
  });

  it("never plans tools that are not in the provided schemas", () => {
    const plan = brainPlan("Search and remember everything about the budget", []);
    for (const step of plan.steps) {
      expect(step.tool).toBeUndefined();
    }
  });

  it("classifies goals", () => {
    expect(isTaskGoal("Search the workspace for earlier decisions about storage")).toBe(true);
    expect(isTaskGoal("hi")).toBe(false);
  });
});

describe("step decisions", () => {
  it("selects the step's tool with derived arguments", () => {
    const decision = decide("find earlier notes about budgets", "workspace.search");
    expect(decision.type).toBe("tool_call");
    if (decision.type === "tool_call") {
      expect(decision.tool).toBe("workspace.search");
      expect(typeof decision.args.query).toBe("string");
    }
  });

  it("answers directly when the step has no tool", () => {
    const decision = decide("anything", undefined);
    expect(decision.type).toBe("answer");
  });

  it("routes preference-style requests to the approval-gated tool", () => {
    const decision = decide("Remember that I always prefer concise answers", "preference.save");
    expect(decision.type).toBe("tool_call");
    if (decision.type === "tool_call") expect(decision.tool).toBe("preference.save");
  });
});

describe("validation & answers", () => {
  it("rejects thin outputs and open steps", () => {
    const open = brainValidate({ goal: "g", steps: [stepOf(undefined)], output: "a long enough output for the validator", observations: [] });
    expect(open.ok).toBe(false);

    const thin = brainValidate({
      goal: "g",
      steps: [{ ...stepOf(undefined), state: "done" }],
      output: "short",
      observations: [],
    });
    expect(thin.ok).toBe(false);

    const good = brainValidate({
      goal: "g",
      steps: [{ ...stepOf(undefined), state: "done" }],
      output: "A sufficiently detailed result that the validator accepts without complaint.",
      observations: [],
    });
    expect(good.ok).toBe(true);
  });

  it("composes an answer that references executed steps", () => {
    const text = brainAnswer("audit the storage layer", [
      { id: "1", title: "Search the workspace", state: "done", attempts: 1, result: "3 hits" },
      { id: "2", title: "Compose the result", state: "done", attempts: 1 },
    ], []);
    expect(text).toContain("Task complete");
    expect(text).toContain("Search the workspace");
  });

  it("summarizes exchanges deterministically", () => {
    const summary = brainSummarize(["user: talk about budgets", "assistant: ok", "user: now storage"]);
    expect(summary).toContain("3 exchanges");
    expect(summary).toContain("storage");
  });
});
