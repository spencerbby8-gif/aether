import type { ContextPack, Observation, PlanStepSpec, Settings, TaskStep, ToolSchema } from "@/lib/types";
import { sleep, uid } from "@/lib/utils";
import { brainPlan, brainStep, brainSummarize, brainValidate } from "./brain";

/**
 * AgentModel — the intelligence behind the runtime.
 * Phase 2 ships MockAgentModel (in-browser) and ServerAgentModel (/api/agent/model).
 * The remote model (Phase 3) implements this exact interface.
 */

export interface PlanRequest {
  goal: string;
  context: ContextPack;
  tools: ToolSchema[];
}

export interface PlanResult {
  steps: PlanStepSpec[];
  note?: string;
}

export interface StepRequest {
  goal: string;
  context: ContextPack;
  steps: TaskStep[];
  currentStep: TaskStep;
  observations: Observation[];
  corrections: string[];
  tools: ToolSchema[];
}

export type StepDecision =
  | { type: "tool_call"; tool: string; args: Record<string, unknown>; description?: string }
  | { type: "answer"; text: string };

export interface ValidateRequest {
  goal: string;
  steps: TaskStep[];
  output: string;
  observations: Observation[];
}

export interface ValidateResult {
  ok: boolean;
  note?: string;
}

export interface AgentModel {
  readonly id: string;
  readonly location: "local" | "server" | "remote";
  plan(request: PlanRequest, signal: AbortSignal): Promise<PlanResult>;
  step(request: StepRequest, signal: AbortSignal): Promise<StepDecision>;
  validate(request: ValidateRequest, signal: AbortSignal): Promise<ValidateResult>;
  summarize(texts: string[], signal: AbortSignal): Promise<string>;
}

/* ------------------------------------------------------------------ */
/* Mock — deterministic on-device intelligence.                        */
/* ------------------------------------------------------------------ */

export class MockAgentModel implements AgentModel {
  readonly id = "mock";
  readonly location = "local" as const;

  async plan(request: PlanRequest): Promise<PlanResult> {
    await sleep(90);
    return brainPlan(request.goal, request.tools);
  }

  async step(request: StepRequest): Promise<StepDecision> {
    await sleep(60);
    return brainStep(request);
  }

  async validate(request: ValidateRequest): Promise<ValidateResult> {
    await sleep(40);
    return brainValidate(request);
  }

  async summarize(texts: string[]): Promise<string> {
    await sleep(30);
    return brainSummarize(texts);
  }
}

export const mockAgentModel = new MockAgentModel();

/* ------------------------------------------------------------------ */
/* Server — JSON endpoint; responses are strictly normalized so a      */
/* malformed remote model can never corrupt the runtime.               */
/* ------------------------------------------------------------------ */

function asPlanResult(value: unknown): PlanResult {
  const record = value as { steps?: unknown };
  if (!record || !Array.isArray(record.steps)) throw new Error("Malformed plan response: missing steps[].");
  const steps: PlanStepSpec[] = [];
  for (const item of record.steps.slice(0, 8)) {
    const spec = item as { id?: unknown; title?: unknown; tool?: unknown; intent?: unknown };
    if (!spec || typeof spec.title !== "string" || spec.title.trim() === "") continue;
    steps.push({
      id: typeof spec.id === "string" && spec.id ? spec.id : uid(),
      title: spec.title.trim().slice(0, 120),
      tool: typeof spec.tool === "string" ? spec.tool : undefined,
      intent: typeof spec.intent === "string" ? spec.intent : undefined,
    });
  }
  if (steps.length === 0) throw new Error("Malformed plan response: no valid steps.");
  return { steps };
}

function asStepDecision(value: unknown): StepDecision {
  const record = value as { type?: unknown; tool?: unknown; args?: unknown; text?: unknown; description?: unknown };
  if (!record) throw new Error("Malformed step response.");
  if (record.type === "tool_call") {
    if (typeof record.tool !== "string" || record.tool.trim() === "") {
      throw new Error("Malformed tool_call: missing tool name.");
    }
    const args = record.args !== null && typeof record.args === "object" ? (record.args as Record<string, unknown>) : {};
    return {
      type: "tool_call",
      tool: record.tool,
      args,
      description: typeof record.description === "string" ? record.description : undefined,
    };
  }
  if (record.type === "answer") {
    if (typeof record.text !== "string") throw new Error("Malformed answer: text must be a string.");
    return { type: "answer", text: record.text };
  }
  throw new Error(`Unknown decision type "${String(record.type)}".`);
}

function asValidateResult(value: unknown): ValidateResult {
  const record = value as { ok?: unknown; note?: unknown };
  if (!record || typeof record.ok !== "boolean") throw new Error("Malformed validation response.");
  return { ok: record.ok, note: typeof record.note === "string" ? record.note : undefined };
}

export class ServerAgentModel implements AgentModel {
  readonly id = "server";
  readonly location = "server" as const;

  private async call(mode: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch("/api/agent/model", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, ...payload }),
        signal,
      });
    } catch (error) {
      if ((error as Error)?.name === "AbortError" || signal.aborted) throw error;
      throw new Error("The model endpoint could not be reached.");
    }
    if (!response.ok) {
      let detail = `Model endpoint responded ${response.status}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body?.error) detail = body.error;
      } catch {
        /* keep status text */
      }
      throw new Error(detail);
    }
    try {
      return await response.json();
    } catch {
      throw new Error("Malformed model response: invalid JSON.");
    }
  }

  async plan(request: PlanRequest, signal: AbortSignal): Promise<PlanResult> {
    return asPlanResult(
      await this.call("plan", { goal: request.goal, context: request.context, tools: request.tools }, signal),
    );
  }

  async step(request: StepRequest, signal: AbortSignal): Promise<StepDecision> {
    return asStepDecision(
      await this.call(
        "step",
        {
          goal: request.goal,
          currentStep: request.currentStep,
          steps: request.steps,
          observations: request.observations,
          corrections: request.corrections,
          tools: request.tools,
        },
        signal,
      ),
    );
  }

  async validate(request: ValidateRequest, signal: AbortSignal): Promise<ValidateResult> {
    return asValidateResult(
      await this.call("validate", { goal: request.goal, steps: request.steps, output: request.output, observations: request.observations }, signal),
    );
  }

  async summarize(texts: string[], signal: AbortSignal): Promise<string> {
    const result = (await this.call("summarize", { texts }, signal)) as { summary?: unknown };
    if (!result || typeof result.summary !== "string") throw new Error("Malformed summary response.");
    return result.summary;
  }
}

export const serverAgentModel = new ServerAgentModel();

/**
 * Intelligence source for the local task runtime (plan/act/observe).
 * Chat itself always runs on the real engine — see /api/agent/stream.
 */
export function resolveAgentModel(online: boolean): AgentModel {
  return online ? serverAgentModel : mockAgentModel;
}
