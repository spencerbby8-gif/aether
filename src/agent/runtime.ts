import type {
  AgentEvent,
  ContextPack,
  RuntimePhase,
  RuntimeTask,
  TaskStatus,
  TaskStep,
} from "@/lib/types";
import { anySignal, sleep, truncate, uid } from "@/lib/utils";
import type { AgentModel, StepDecision } from "./model";
import type { ToolRegistry } from "./tools";

/**
 * AgentRuntime — Aether's execution engine.
 *
 *   plan → act → observe → validate → continue/complete
 *
 * The runtime owns task state, retries, cancellation, pause/resume,
 * approval gates and recovery. Intelligence comes from an injected
 * AgentModel; capability comes from an injected ToolRegistry. Only safe,
 * user-facing text is ever emitted — hidden reasoning stays hidden.
 */

export class RuntimeCancelled extends Error {
  constructor() {
    super("The task was cancelled.");
    this.name = "RuntimeCancelled";
  }
}

export interface RuntimeOptions {
  model: AgentModel;
  /** Used automatically when the primary model keeps failing. */
  fallbackModel?: AgentModel;
  tools: ToolRegistry;
  context: ContextPack;
  streaming?: boolean;
  /** Execution attempts per step (model calls + tool executions). */
  maxStepAttempts?: number;
  /** How many invalid-tool-call corrections the model may try per step. */
  maxCorrections?: number;
  modelTimeoutMs?: number;
  toolTimeoutMs?: number;
  onEvent: (event: AgentEvent) => void;
  onSnapshot: (task: RuntimeTask) => void;
}

function describeError(error: unknown): string {
  if (!error) return "unknown error";
  const e = error as { name?: string; message?: string };
  if (e.name === "TimeoutError") return "timeout";
  return e.message ?? "unknown error";
}

export class AgentRuntime {
  private ac = new AbortController();
  private paused = false;
  private finished = false;
  private resumeWaiters: Array<() => void> = [];
  private approvalWaiters = new Map<string, (approved: boolean) => void>();
  private model: AgentModel;
  private validationRetried = false;
  private opts: RuntimeOptions;
  private task: RuntimeTask;

  constructor(task: RuntimeTask, options: RuntimeOptions) {
    this.task = task;
    this.opts = options;
    this.model = options.model;
    this.task.startedAt ??= Date.now();
  }

  get taskId(): string {
    return this.task.id;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /* ---------------- controls ---------------- */

  cancel(): void {
    if (this.finished) return;
    this.ac.abort();
    /* Unblock gates so the loop can observe the abort immediately. */
    for (const waiter of this.approvalWaiters.values()) waiter(false);
    this.approvalWaiters.clear();
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    waiters.forEach((w) => w());
  }

  pause(): void {
    if (this.finished || this.paused) return;
    this.paused = true;
    this.setStatus("paused");
    this.note("Paused by user.");
    this.emit({ type: "phase", phase: "paused" });
  }

  resume(): void {
    if (this.finished || !this.paused) return;
    this.paused = false;
    this.setStatus("running");
    this.note("Resumed.");
    this.emit({ type: "phase", phase: "executing" });
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    waiters.forEach((w) => w());
  }

  resolveApproval(requestId: string, approved: boolean): void {
    const waiter = this.approvalWaiters.get(requestId);
    if (!waiter) return;
    this.approvalWaiters.delete(requestId);
    const approval = this.task.approvals.find((a) => a.id === requestId);
    if (approval) {
      approval.status = approved ? "approved" : "declined";
      approval.resolvedAt = Date.now();
      this.log(approved ? `Approved: ${approval.tool}` : `Declined: ${approval.tool}`);
    }
    this.snapshot();
    waiter(approved);
  }

  /* ---------------- main loop ---------------- */

  async run(): Promise<RuntimeTask> {
    try {
      if (this.task.steps.length === 0) {
        await this.planPhase();
      } else {
        this.log("Resuming from persisted steps.");
      }
      /* A task killed mid-step persists that step as "running" — reset it so
         the loop actually re-executes it on resume. */
      for (const step of this.task.steps) {
        if (step.state === "running") {
          step.state = "pending";
          step.attempts = 0;
          step.startedAt = undefined;
        }
      }
      await this.executeLoop();
      await this.validatePhase();
      this.finish("completed");
    } catch (error) {
      if (error instanceof RuntimeCancelled || this.ac.signal.aborted) {
        this.finish("cancelled");
      } else {
        this.task.error = describeError(error);
        this.log(`Failed: ${this.task.error}`);
        this.finish("failed");
      }
    }
    return this.snapshot();
  }

  /* ---------------- phases ---------------- */

  private async planPhase(): Promise<void> {
    this.setPhase("planning");
    this.setStatus("planning");
    this.log("Planning the task.");
    const plan = await this.callModel(
      (model, signal) =>
        model.plan({ goal: this.task.goal, context: this.opts.context, tools: this.opts.tools.schemas() }, signal),
      "planning",
    );
    this.task.steps = plan.steps.map((spec) => ({
      id: spec.id || uid(),
      title: truncate(spec.title, 120) || "Step",
      state: "pending" as const,
      attempts: 0,
      tool: spec.tool,
      intent: spec.intent,
    }));
    this.emit({
      type: "plan",
      taskId: this.task.id,
      steps: this.task.steps.map((s) => ({ id: s.id, title: s.title, tool: s.tool })),
    });
    this.log(`Plan ready — ${this.task.steps.length} step(s).`);
    this.snapshot();
  }

  private async executeLoop(): Promise<void> {
    for (;;) {
      await this.gate();
      this.checkAbort();
      const step = this.task.steps.find((s) => s.state === "pending");
      if (!step) break;
      await this.runStep(step.id);
      this.snapshot();
    }
  }

  private async runStep(stepId: string): Promise<void> {
    const step = this.task.steps.find((s) => s.id === stepId);
    if (!step) return;
    step.state = "running";
    step.startedAt ??= Date.now();
    this.setPhase("executing");
    this.setStatus("running");

    const maxAttempts = this.opts.maxStepAttempts ?? 3;
    const maxCorrections = this.opts.maxCorrections ?? 2;
    const corrections: string[] = [];

    try {
      await this.runStepAttempts(step, maxAttempts, maxCorrections, corrections);
      const after = this.task.steps.find((s) => s.id === stepId);
      if (after && after.state === "failed") {
        throw new Error(after.error ?? "The step failed.");
      }
    } catch (error) {
      /* Guarantee a non-terminal step is persisted as failed before the
         task exits — otherwise retries could never find it again. */
      const current = this.task.steps.find((s) => s.id === stepId);
      if (current && current.state !== "done" && current.state !== "failed" && current.state !== "declined") {
        this.failStep(current, describeError(error));
      }
      throw error;
    }
  }

  private async runStepAttempts(
    step: TaskStep,
    maxAttempts: number,
    maxCorrections: number,
    corrections: string[],
  ): Promise<void> {

    for (;;) {
      await this.gate();
      this.checkAbort();
      step.attempts += 1;
      this.emitStep(step, "running");

      let decision: StepDecision;
      try {
        decision = await this.callModel(
          (model, signal) =>
            model.step(
              {
                goal: this.task.goal,
                context: this.opts.context,
                steps: this.task.steps,
                currentStep: step,
                observations: this.task.observations,
                corrections,
                tools: this.opts.tools.schemas(),
              },
              signal,
            ),
          "step",
        );
      } catch (error) {
        this.checkAbort();
        this.failStep(step, describeError(error));
        return;
      }

      if (decision.type === "answer") {
        step.state = "done";
        step.finishedAt = Date.now();
        step.result = "Answered";
        this.task.output = decision.text;
        this.emitStep(step, "done");
        this.log(`Answer composed (${decision.text.length} chars).`);
        await this.emitAnswer(decision.text);
        return;
      }

      /* ---- act: tool call ---- */
      const executor = this.opts.tools.get(decision.tool);
      if (!executor) {
        const message = `Tool "${decision.tool}" does not exist in the registry.`;
        corrections.push(message);
        this.note(`${message} Asking the model to correct.`);
        if (corrections.length > maxCorrections) {
          this.failStep(step, "Too many invalid tool calls.");
          return;
        }
        continue;
      }

      const argError = this.opts.tools.validateArgs(executor.schema, decision.args ?? {});
      if (argError) {
        corrections.push(argError);
        this.note(`${argError} Asking the model to correct.`);
        if (corrections.length > maxCorrections) {
          this.failStep(step, "Tool arguments stayed invalid after corrections.");
          return;
        }
        continue;
      }

      /* ---- approval gate ---- */
      if (executor.schema.requiresApproval) {
        const approval = {
          id: uid(),
          taskId: this.task.id,
          stepId: step.id,
          tool: decision.tool,
          description: decision.description ?? `Run ${decision.tool}?`,
          status: "pending" as const,
        };
        this.task.approvals.push(approval);
        this.setPhase("waiting");
        this.setStatus("waiting_approval");
        this.emit({
          type: "approval_request",
          requestId: approval.id,
          taskId: this.task.id,
          stepId: step.id,
          tool: decision.tool,
          description: approval.description,
        });
        this.log(`Waiting for approval: ${decision.tool}`);
        this.snapshot();

        const approved = await new Promise<boolean>((resolve) => {
          this.approvalWaiters.set(approval.id, resolve);
        });
        this.checkAbort();
        if (!approved) {
          step.state = "declined";
          step.finishedAt = Date.now();
          step.result = "Declined by user";
          this.emitStep(step, "declined");
          this.setPhase("executing");
          this.setStatus("running");
          return;
        }
        this.setPhase("executing");
        this.setStatus("running");
      }

      /* ---- observe: execute the tool with a timeout ---- */
      const callId = uid();
      this.emit({ type: "tool_call", callId, tool: decision.tool, description: decision.description });
      this.emit({ type: "tool", id: callId, name: decision.tool, state: "running", detail: decision.description });

      try {
        const signal = anySignal([this.ac.signal, AbortSignal.timeout(this.opts.toolTimeoutMs ?? 120_000)]);
        let lastProgressNote = 0;
        const raw = await executor.execute(
          decision.args ?? {},
          {
            taskId: this.task.id,
            conversationId: this.task.conversationId,
            projectId: this.task.projectId,
            goalHint: this.task.goal,
            onProgress: (detail) => {
              const now = Date.now();
              if (now - lastProgressNote < 400) return;
              lastProgressNote = now;
              this.note(`${decision.tool}: ${detail}`);
            },
          },
          signal,
        );
        /* Normalize string results and structured ToolOutput alike. */
        const output =
          typeof raw === "string" ? { text: raw } : raw;
        const text = output.text;
        if (output.artifacts && output.artifacts.length > 0) {
          this.task.artifacts = [...(this.task.artifacts ?? []), ...output.artifacts];
        }
        if (output.attachments && output.attachments.length > 0) {
          const existing = new Set((this.task.attachments ?? []).map((a) => a.id));
          const fresh = output.attachments.filter((a) => !existing.has(a.id));
          this.task.attachments = [...(this.task.attachments ?? []), ...fresh];
        }
        this.task.observations.push({ stepId: step.id, tool: decision.tool, ok: true, text: truncate(text, 900) });
        if (executor.capturesOutput) {
          this.task.output = this.task.output ? `${this.task.output}\n\n${truncate(text, 900)}` : truncate(text, 900);
        }
        step.state = "done";
        step.finishedAt = Date.now();
        step.result = truncate(text, 300);
        this.emit({ type: "tool", id: callId, name: decision.tool, state: "done", detail: truncate(text, 120) });
        this.emitStep(step, "done");
        this.log(`${decision.tool} completed${typeof output.exitCode === "number" ? ` (exit ${output.exitCode})` : ""}.`);
        return;
      } catch (error) {
        this.checkAbort();
        const reason = describeError(error);
        const message =
          (error as { name?: string })?.name === "TimeoutError"
            ? `Tool "${decision.tool}" timed out.`
            : `Tool "${decision.tool}" failed: ${reason}`;
        this.task.observations.push({ stepId: step.id, tool: decision.tool, ok: false, text: message });
        this.emit({ type: "tool", id: callId, name: decision.tool, state: "error", detail: message });
        this.log(message);
        if (step.attempts >= maxAttempts) {
          this.failStep(step, message);
          return;
        }
        this.note(`Retrying step — attempt ${step.attempts + 1} of ${maxAttempts}.`);
        this.snapshot();
        await sleep(180 * step.attempts);
      }
    }
  }

  private async validatePhase(): Promise<void> {
    if (!this.task.output) {
      this.task.output = this.task.observations.map((o) => o.text).join("\n") || "(no result)";
    }
    this.setPhase("validating");
    this.setStatus("validating");
    this.log("Validating results.");

    let result: { ok: boolean; note?: string };
    try {
      result = await this.callModel(
        (model, signal) =>
          model.validate(
            { goal: this.task.goal, steps: this.task.steps, output: this.task.output ?? "", observations: this.task.observations },
            signal,
          ),
        "validation",
      );
    } catch (error) {
      this.checkAbort();
      /* A broken validator must never destroy finished work — accept with a note. */
      result = { ok: true, note: `Validation skipped: ${describeError(error)}` };
    }

    if (!result.ok && !this.validationRetried) {
      this.validationRetried = true;
      this.note(`Validation failed (${result.note ?? "unknown"}) — regenerating.`);
      const lastDone = [...this.task.steps].reverse().find((s) => s.state === "done");
      if (lastDone) {
        lastDone.state = "pending";
        lastDone.result = undefined;
      }
      this.task.output = undefined;
      await this.executeLoop();
      await this.validatePhase();
      return;
    }

    this.log(result.ok ? "Validation passed." : `Accepted with note: ${result.note ?? "unknown"}`);
  }

  /* ---------------- recovery: model call wrapper ---------------- */

  private async callModel<T>(
    call: (model: AgentModel, signal: AbortSignal) => Promise<T>,
    label: string,
  ): Promise<T> {
    const candidates = this.opts.fallbackModel ? [this.model, this.opts.fallbackModel] : [this.model];
    let lastError: unknown;

    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        await this.gate();
        this.checkAbort();
        const signal = anySignal([this.ac.signal, AbortSignal.timeout(this.opts.modelTimeoutMs ?? 20_000)]);
        try {
          const result = await call(candidate, signal);
          if (candidate !== this.model) this.model = candidate;
          return result;
        } catch (error) {
          this.checkAbort();
          lastError = error;
          if (attempt < 2) {
            this.note(`Model call failed during ${label} (${describeError(error)}) — retrying.`);
            await sleep(160 * attempt);
          }
        }
      }
      if (i < candidates.length - 1) {
        this.note("Primary model unavailable — switched to the on-device fallback model.");
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`The model failed during ${label}.`);
  }

  /* ---------------- helpers ---------------- */

  /** Marks a step failed and persists the snapshot; does not throw. */
  private failStep(step: { id: string }, message: string): void {
    const target = this.task.steps.find((s) => s.id === step.id);
    if (!target) return;
    target.state = "failed";
    target.error = message;
    target.finishedAt = Date.now();
    this.emitStep(target, "failed");
    this.log(`Step failed: ${message}`);
    this.task.error = message;
    this.snapshot();
  }

  private async emitAnswer(text: string): Promise<void> {
    if (!this.opts.streaming) {
      this.emit({ type: "delta", text });
      return;
    }
    for (let i = 0; i < text.length; ) {
      this.checkAbort();
      const size = 4 + Math.floor(Math.random() * 6);
      this.emit({ type: "delta", text: text.slice(i, i + size) });
      i += size;
      await sleep(6);
    }
  }

  private async gate(): Promise<void> {
    if (this.ac.signal.aborted) throw new RuntimeCancelled();
    if (!this.paused) return;
    await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
    this.checkAbort();
  }

  private checkAbort(): void {
    if (this.ac.signal.aborted) throw new RuntimeCancelled();
  }

  private emit(event: AgentEvent): void {
    this.opts.onEvent(event);
  }

  private note(text: string): void {
    this.emit({ type: "note", text });
    this.log(text);
  }

  private log(text: string): void {
    this.task.events.push({ at: Date.now(), text });
    if (this.task.events.length > 60) this.task.events = this.task.events.slice(-60);
  }

  private emitStep(step: { id: string; state: string; title: string; attempts: number; result?: string; error?: string }, state: "running" | "done" | "failed" | "declined"): void {
    this.emit({
      type: "step",
      taskId: this.task.id,
      stepId: step.id,
      state,
      title: step.title,
      attempt: step.attempts,
      result: step.result,
      error: step.error,
    });
  }

  private setPhase(phase: RuntimePhase): void {
    this.emit({ type: "phase", phase });
  }

  private setStatus(status: TaskStatus): void {
    this.task.status = status;
    this.snapshot();
  }

  private finish(status: TaskStatus): void {
    if (this.finished) return;
    this.finished = true;
    this.task.status = status;
    this.task.finishedAt = Date.now();
    const phase: RuntimePhase =
      status === "completed" ? "completed" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "interrupted";
    this.setPhase(phase);
    this.log(status === "completed" ? "Task completed." : `Task ${status}.`);
    this.emit({ type: "task_done", taskId: this.task.id, status, output: this.task.output });
    this.snapshot();
  }

  private snapshot(): RuntimeTask {
    const clone = structuredClone(this.task);
    this.opts.onSnapshot(clone);
    return clone;
  }
}
