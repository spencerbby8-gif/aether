import type { AgentModel, PlanResult, StepDecision, ValidateResult } from "@/agent/model";
import type { PlanRequest, StepRequest, ValidateRequest } from "@/agent/model";
import { ToolRegistry, type ToolExecutor } from "@/agent/tools";
import type { ContextPack, PlanStepSpec } from "@/lib/types";

export function makeContext(goal = "test goal"): ContextPack {
  return {
    goal,
    recent: [{ role: "user", content: goal }],
    relevantHistory: [],
    memory: [],
    files: [],
  };
}

export function makeSteps(specs: Array<{ title: string; tool?: string }>): PlanStepSpec[] {
  return specs.map((spec, index) => ({ id: `step-${index}`, title: spec.title, tool: spec.tool }));
}

/** Deterministic model for runtime tests. */
export class ScriptedModel implements AgentModel {
  readonly id = "scripted";
  readonly location = "local" as const;
  planCalls = 0;
  stepCalls = 0;
  validateCalls = 0;
  summarizeCalls = 0;

  constructor(
    private opts: {
      planSteps?: PlanStepSpec[];
      planError?: Error;
      decisions?: Array<StepDecision | Error | "hang">;
      validateResult?: ValidateResult;
    } = {},
  ) {}

  private decisions: Array<StepDecision | Error | "hang"> = [...(this.opts.decisions ?? [])];

  async plan(_request: PlanRequest): Promise<PlanResult> {
    this.planCalls += 1;
    if (this.opts.planError) throw this.opts.planError;
    return { steps: this.opts.planSteps ?? [] };
  }

  async step(_request: StepRequest, signal: AbortSignal): Promise<StepDecision> {
    this.stepCalls += 1;
    const next = this.decisions.shift();
    if (next === undefined) {
      return { type: "answer", text: "Scripted fallback answer — long enough to pass validation thresholds." };
    }
    if (next === "hang") {
      /* Hangs until the runtime's timeout signal fires — like a stuck model. */
      return new Promise<StepDecision>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("The model call timed out.");
          error.name = "TimeoutError";
          reject(error);
        });
      });
    }
    if (next instanceof Error) throw next;
    return next;
  }

  async validate(_request: ValidateRequest): Promise<ValidateResult> {
    this.validateCalls += 1;
    return this.opts.validateResult ?? { ok: true };
  }

  async summarize(texts: string[]): Promise<string> {
    this.summarizeCalls += 1;
    return `Summary of ${texts.length} messages.`;
  }
}

export function makeRegistry(executors: ToolExecutor[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const executor of executors) registry.register(executor);
  return registry;
}

export const echoTool: ToolExecutor = {
  schema: {
    name: "echo",
    description: "Echoes input — test tool.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  async execute(args) {
    return `echo:${String(args.text ?? "")}`;
  },
};

export const flakyTool = (failures: number): ToolExecutor => {
  let remaining = failures;
  return {
    schema: {
      name: "flaky",
      description: "Fails a fixed number of times before succeeding.",
      parameters: { type: "object", properties: { text: { type: "string" } } },
    },
    async execute() {
      if (remaining > 0) {
        remaining -= 1;
        throw new Error("flaky failure");
      }
      return "flaky-ok";
    },
  };
};

export const alwaysFailingTool: ToolExecutor = {
  schema: {
    name: "broken",
    description: "Always fails.",
    parameters: { type: "object", properties: {} },
  },
  async execute() {
    throw new Error("permanent failure");
  },
};

export const approvalTool: ToolExecutor = {
  schema: {
    name: "needs-approval",
    description: "Requires user approval.",
    requiresApproval: true,
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  async execute(args) {
    return `approved:${String(args.text ?? "")}`;
  },
};
