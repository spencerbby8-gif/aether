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
import { findCycle, partitionBySafety, planWaves, runnableSteps, skipUnrunnable } from "./task-graph";
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
  /**
   * How many independent steps may run at once.
   *
   * A real limit rather than an unbounded fan-out: each concurrent step costs a
   * model call and a tool invocation, and on a single-engine backend they queue
   * anyway, so a large number buys latency and nothing else.
   */
  maxParallelSteps?: number;
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
    const known = new Set(plan.steps.map((spec) => spec.id || ""));
    this.task.steps = plan.steps.map((spec) => {
      const id = spec.id || uid();
      /* Trust nothing the planner asserts about the graph. A dependency on a
         step that does not exist, or on itself, would make the step permanently
         unrunnable -- so drop those rather than let a bad plan wedge the task. */
      const deps = (spec.dependsOn ?? []).filter((d) => known.has(d) && d !== id);
      return {
        id,
        title: truncate(spec.title, 120) || "Step",
        state: "pending" as const,
        attempts: 0,
        tool: spec.tool,
        intent: spec.intent,
        dependsOn: deps,
        parallelSafe: spec.parallelSafe === true,
      };
    });

    /* A cyclic plan has no runnable step at all, so it would deadlock before it
       started. Falling back to no dependencies keeps the task moving in written
       order, which is slower but correct, and says so out loud. */
    const cycle = findCycle(this.task.steps);
    if (cycle) {
      this.note(`the plan contained a dependency loop (${cycle.join(" -> ")}); running steps in order`);
      for (const s of this.task.steps) s.dependsOn = [];
    }
    const waves = planWaves(this.task.steps);
    waves.forEach((wave, i) => {
      for (const id of wave) {
        const step = this.task.steps.find((s) => s.id === id);
        if (step) step.wave = i;
      }
    });

    this.emit({
      type: "plan",
      taskId: this.task.id,
      steps: this.task.steps.map((s) => ({ id: s.id, title: s.title, tool: s.tool })),
    });
    const parallelWaves = waves.filter((w) => w.length > 1).length;
    this.log(
      `Plan ready — ${this.task.steps.length} step(s) in ${waves.length} wave(s)`
        + (parallelWaves > 0 ? `, ${parallelWaves} of them parallel` : "") + ".",
    );
    this.snapshot();
  }

  /**
   * Run the plan wave by wave.
   *
   * Steps whose prerequisites are done and which are marked parallel-safe run
   * concurrently; everything else runs one at a time. A step that fails skips
   * the work downstream of it rather than leaving it pending, so the loop always
   * reaches an end instead of waiting on something that can never start.
   */
  private async executeLoop(): Promise<void> {
    /* A step failure must still fail the task. Swallowing it here would let a
       run report "completed" after its own steps broke, which is the one thing
       the task layer exists to prevent. */
    let firstError: unknown = null;
    for (;;) {
      await this.gate();
      this.checkAbort();

      const ready = runnableSteps(this.task.steps);
      if (ready.length === 0) {
        /* Nothing can start. Either the plan is finished or it is blocked behind
           a failure -- skip what can never run so the task can reach a truthful
           end state instead of reporting unfinished work for ever. */
        const skipped = skipUnrunnable(this.task.steps, "skipped: a prerequisite did not complete");
        if (skipped.length > 0) {
          this.note(`${skipped.length} step(s) skipped because a prerequisite failed`);
          this.snapshot();
        }
        break;
      }

      const { parallel, serial } = partitionBySafety(ready);
      const limit = this.opts.maxParallelSteps ?? 3;

      /* Independent, read-only work goes first and overlaps, capped. */
      for (let i = 0; i < parallel.length; i += limit) {
        this.checkAbort();
        const batch = parallel.slice(i, i + limit);
        if (batch.length > 1) {
          this.note(`running ${batch.length} steps in parallel`);
          /* allSettled, not all: one failure must not cancel the siblings that
             are already in flight, and each step records its own outcome. */
          const settled = await Promise.allSettled(batch.map((s) => this.runStep(s.id)));
          const broke = settled.filter(
            (r): r is PromiseRejectedResult => r.status === "rejected",
          );
          if (broke.length > 0) {
            this.note(`${broke.length} parallel step(s) failed`);
            firstError ??= broke[0].reason;
          }
        } else {
          firstError ??= await this.runStepCatching(batch[0].id);
        }
        this.snapshot();
      }

      /* Stateful steps never overlap, with each other or with anything else. */
      for (const step of serial) {
        this.checkAbort();
        firstError ??= await this.runStepCatching(step.id);
        this.snapshot();
      }

      /* Finish the work already in flight, then stop: starting a new wave on top
         of a known failure just spends budget on a task that cannot succeed.
         The blocked work is marked skipped on the way out -- leaving it pending
         would make the task look unfinished for ever. */
      if (firstError !== null) {
        const blocked = skipUnrunnable(this.task.steps, "skipped: a prerequisite did not complete");
        if (blocked.length > 0) {
          this.note(`${blocked.length} step(s) skipped because a prerequisite failed`);
        }
        this.snapshot();
        break;
      }
    }
    if (firstError !== null) throw firstError;
  }

  /** Run one step, returning its error instead of throwing it. */
  private async runStepCatching(stepId: string): Promise<unknown> {
    try {
      await this.runStep(stepId);
      return null;
    } catch (error) {
      /* The step has already been recorded as failed by runStep. The error is
         returned rather than thrown so the current wave can finish, and the
         caller re-throws it once nothing useful is left to do. */
      return error;
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
