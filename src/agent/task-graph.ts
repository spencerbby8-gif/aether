/**
 * Dependency scheduling for a plan, on the TypeScript side.
 *
 * Mirrors the semantics of the Android `TaskGraph` so both ends of the app agree
 * on what "runnable" means: a step is ready when every step it depends on has
 * finished successfully, independent steps may run at the same time, and a step
 * whose prerequisite failed is skipped rather than attempted.
 *
 * These are pure functions over plain arrays. No I/O, no state, so they can be
 * tested directly and reasoned about without running an agent.
 */

import type { StepState, TaskStep } from "@/lib/types";

/** Steps that may start right now: pending, with every dependency done. */
export function runnableSteps(steps: readonly TaskStep[]): TaskStep[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  return steps.filter((s) => {
    if (s.state !== "pending") return false;
    const deps = s.dependsOn ?? [];
    return deps.every((d) => byId.get(d)?.state === "done");
  });
}

/**
 * The plan grouped into waves that may run concurrently.
 *
 * Computed from the plan's shape, not from what is left to do, so a finished
 * task still reports the schedule it actually had. Returns an empty list when
 * the plan contains a cycle, because there is no honest ordering to give.
 */
export function planWaves(steps: readonly TaskStep[]): string[][] {
  /* Deliberately computed from the plan's SHAPE, ignoring current state. An
     earlier version keyed off each step's live state, so a finished task
     reported zero waves and the UI lost the fact that any of it had run in
     parallel. What is runnable right now is runnableSteps()'s job; this is the
     schedule. */
  const remaining = new Map(steps.map((s) => [s.id, "pending" as StepState]));
  const waves: string[][] = [];
  for (;;) {
    const wave: string[] = [];
    for (const s of steps) {
      if (remaining.get(s.id) !== "pending") continue;
      const deps = s.dependsOn ?? [];
      if (deps.every((d) => remaining.get(d) === "done")) wave.push(s.id);
    }
    if (wave.length === 0) break;
    for (const id of wave) remaining.set(id, "done");
    waves.push(wave);
    if (waves.length > steps.length) break; // a cycle would otherwise spin here
  }
  const scheduled = waves.reduce((n, w) => n + w.length, 0);
  return scheduled === steps.length ? waves : [];
}

/** A cycle in the dependency graph, as the chain of ids, or null. */
export function findCycle(steps: readonly TaskStep[]): string[] | null {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const done = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    if (stack.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (done.has(id)) return null;
    stack.add(id);
    path.push(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      const found = visit(d);
      if (found) return found;
    }
    path.pop();
    stack.delete(id);
    done.add(id);
    return null;
  };

  for (const s of steps) {
    const found = visit(s.id);
    if (found) return found;
  }
  return null;
}

/** True when a step is safe to overlap with others. Defaults to false. */
export function isParallelSafe(step: TaskStep): boolean {
  return step.parallelSafe === true;
}

/**
 * Split a wave into what may overlap and what must not.
 *
 * The default is serial: a step has to say it is read-only before it is allowed
 * to run alongside another, because the cost of guessing wrong is a corrupted
 * file or two processes fighting over the same state.
 */
export function partitionBySafety(wave: readonly TaskStep[]): {
  parallel: TaskStep[];
  serial: TaskStep[];
} {
  const parallel: TaskStep[] = [];
  const serial: TaskStep[] = [];
  for (const s of wave) (isParallelSafe(s) ? parallel : serial).push(s);
  return { parallel, serial };
}

/**
 * Mark every pending step that can never run as skipped.
 *
 * A step whose prerequisite failed is not a step that broke, and leaving it
 * pending would make the task look unfinished for ever. Returns the ids changed.
 */
export function skipUnrunnable(steps: readonly TaskStep[], reason: string): string[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const skipped: string[] = [];
  for (;;) {
    let changed = false;
    for (const s of steps) {
      if (s.state !== "pending") continue;
      const blocked = (s.dependsOn ?? []).some((d) => {
        const dep = byId.get(d);
        return dep && (dep.state === "failed" || dep.state === "skipped" || dep.state === "declined");
      });
      if (!blocked) continue;
      s.state = "skipped";
      s.error = reason;
      s.finishedAt ??= Date.now();
      skipped.push(s.id);
      changed = true;
    }
    if (!changed) break;
  }
  return skipped;
}

/** True when work remains but nothing can start and nothing is in flight. */
export function isDeadlocked(steps: readonly TaskStep[]): boolean {
  if (steps.some((s) => s.state === "running")) return false;
  if (!steps.some((s) => s.state === "pending")) return false;
  return runnableSteps(steps).length === 0;
}
