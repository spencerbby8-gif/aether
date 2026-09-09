import { describe, expect, it } from "vitest";

import type { TaskStep } from "@/lib/types";

import {
  findCycle,
  isDeadlocked,
  partitionBySafety,
  planWaves,
  runnableSteps,
  skipUnrunnable,
} from "@/agent/task-graph";

function step(id: string, dependsOn: string[] = [], parallelSafe = false): TaskStep {
  return { id, title: id, state: "pending", attempts: 0, dependsOn, parallelSafe };
}

describe("runnableSteps", () => {
  it("starts with everything that has no dependencies", () => {
    const steps = [step("a"), step("b"), step("c", ["a", "b"])];
    expect(runnableSteps(steps).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("releases a step only once every prerequisite is done", () => {
    const steps = [step("a"), step("b"), step("c", ["a", "b"])];
    steps[0].state = "done";
    expect(runnableSteps(steps).map((s) => s.id)).toEqual(["b"]);
    steps[1].state = "done";
    expect(runnableSteps(steps).map((s) => s.id)).toEqual(["c"]);
  });

  it("never releases a step whose prerequisite failed", () => {
    const steps = [step("a"), step("c", ["a"])];
    steps[0].state = "failed";
    expect(runnableSteps(steps)).toEqual([]);
  });
});

describe("planWaves", () => {
  it("groups independent steps together", () => {
    const steps = [step("a"), step("b"), step("c", ["a", "b"]), step("d", ["c"])];
    expect(planWaves(steps)).toEqual([["a", "b"], ["c"], ["d"]]);
  });

  it("describes the plan, not what is left to do", () => {
    const steps = [step("a"), step("b"), step("c", ["a", "b"])];
    for (const s of steps) s.state = "done";
    expect(planWaves(steps)).toEqual([["a", "b"], ["c"]]);
  });

  it("returns nothing for a plan that cannot be ordered", () => {
    const steps = [step("x", ["y"]), step("y", ["x"])];
    expect(planWaves(steps)).toEqual([]);
  });

  it("schedules the codebase workflow with exactly one parallel wave", () => {
    const steps = [
      step("inspect"),
      step("install", ["inspect"]),
      step("modify", ["inspect"]),
      step("run", ["modify"]),
      step("test", ["install", "run"]),
      step("build", ["test"]),
    ];
    const waves = planWaves(steps);
    expect(waves).toHaveLength(5);
    expect(waves.filter((w) => w.length > 1)).toEqual([["install", "modify"]]);
  });
});

describe("findCycle", () => {
  it("names the loop", () => {
    expect(findCycle([step("x", ["y"]), step("y", ["x"])])).toEqual(["x", "y", "x"]);
  });

  it("finds nothing in a valid plan", () => {
    expect(findCycle([step("a"), step("b", ["a"])])).toBeNull();
  });

  it("rejects a self-reference", () => {
    expect(findCycle([step("a", ["a"])])).toEqual(["a", "a"]);
  });
});

describe("partitionBySafety", () => {
  it("defaults to serial unless a step says it is safe", () => {
    const { parallel, serial } = partitionBySafety([step("a"), step("b", [], true)]);
    expect(parallel.map((s) => s.id)).toEqual(["b"]);
    expect(serial.map((s) => s.id)).toEqual(["a"]);
  });

  it("keeps stateful work out of the parallel group", () => {
    const wave = [step("read1", [], true), step("read2", [], true), step("write")];
    const { parallel, serial } = partitionBySafety(wave);
    expect(parallel).toHaveLength(2);
    expect(serial.map((s) => s.id)).toEqual(["write"]);
  });
});

describe("skipUnrunnable", () => {
  it("skips everything downstream of a failure, transitively", () => {
    const steps = [step("a"), step("b", ["a"]), step("c", ["b"]), step("d")];
    steps[0].state = "failed";
    const skipped = skipUnrunnable(steps, "prerequisite failed");
    expect(skipped).toEqual(["b", "c"]);
    expect(steps[3].state).toBe("pending");
    expect(steps[1].error).toBe("prerequisite failed");
  });

  it("leaves a runnable plan alone", () => {
    const steps = [step("a"), step("b", ["a"])];
    expect(skipUnrunnable(steps, "unused")).toEqual([]);
  });
});

describe("isDeadlocked", () => {
  it("is true when work remains but nothing can start", () => {
    const steps = [step("a"), step("b", ["a"])];
    steps[0].state = "failed";
    expect(isDeadlocked(steps)).toBe(true);
  });

  it("is false while a step is still running", () => {
    const steps = [step("a"), step("b", ["a"])];
    steps[0].state = "running";
    expect(isDeadlocked(steps)).toBe(false);
  });

  it("is false once everything has settled", () => {
    const steps = [step("a"), step("b", ["a"])];
    steps[0].state = "done";
    steps[1].state = "done";
    expect(isDeadlocked(steps)).toBe(false);
  });
});
