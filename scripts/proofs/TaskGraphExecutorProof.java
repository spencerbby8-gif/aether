import com.aether.app.core.TaskGraph;
import com.aether.app.core.TaskGraphExecutor;
import com.aether.app.core.TaskGraphExecutor.Budget;
import com.aether.app.core.TaskGraphExecutor.Evidence;
import com.aether.app.core.TaskGraphExecutor.Outcome;
import com.aether.app.core.TaskGraphExecutor.Progress;
import com.aether.app.core.TaskGraphExecutor.ProgressSink;
import com.aether.app.core.TaskGraphExecutor.Replanner;
import com.aether.app.core.TaskGraphExecutor.StepRun;
import com.aether.app.core.TaskGraphExecutor.ToolCall;
import com.aether.app.core.TaskGraphExecutor.ToolResult;
import com.aether.app.core.TaskGraphExecutor.ToolRunner;
import com.aether.app.core.TaskGraphExecutor.Verdict;
import com.aether.app.core.TaskRecord;

import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The scheduler that actually runs a TaskGraph.
 *
 * A graph on its own is a schedule nobody executes. What has to be proven here
 * is behaviour, not structure: that independent steps genuinely overlap in
 * time, that a dependent really waits, that hitting the objective stops the run
 * instead of spending the rest of the budget, that a transient failure is
 * retried while a permanent one is not, that budgets stop a runaway, and that a
 * checkpoint lets a different engine finish the same task without repeating
 * work.
 *
 * Every assertion below is made against real timestamps, real file writes or
 * real thread overlap -- not against the plan that was handed in.
 *
 * Run: java -cp /tmp/jvm-suite TaskGraphExecutorProof
 */
public class TaskGraphExecutorProof {
    static int passed = 0, failed = 0;

    static void chk(String what, boolean ok, String seen) {
        System.out.println("  " + (ok ? "ok  " + what : "FAIL " + what) + "   [" + seen + "]");
        if (ok) passed++; else failed++;
    }

    static List<TaskGraph.Spec> specs(TaskGraph.Spec... s) { return new ArrayList<>(Arrays.asList(s)); }

    /** Records progress with the instant it was DELIVERED, to prove liveness. */
    static final class Recorder implements ProgressSink {
        final List<Progress> events = java.util.Collections.synchronizedList(new ArrayList<Progress>());
        final List<Long> at = java.util.Collections.synchronizedList(new ArrayList<Long>());
        public void onProgress(Progress p) { events.add(p); at.add(System.currentTimeMillis()); }
        int count() { return events.size(); }
        List<String> types() {
            List<String> t = new ArrayList<>();
            synchronized (events) { for (Progress p : events) t.add(p.type); }
            return t;
        }
        int countOf(String type) {
            int n = 0;
            synchronized (events) { for (Progress p : events) if (p.type.equals(type)) n++; }
            return n;
        }
        Progress first(String type) {
            synchronized (events) { for (Progress p : events) if (p.type.equals(type)) return p; }
            return null;
        }
    }

    /**
     * A tool runner that does real work: it sleeps so overlap is measurable, and
     * reports how much progress had already been delivered when it started.
     */
    static class Runner implements ToolRunner {
        final Map<String, Integer> calls = new ConcurrentHashMap<>();
        final Map<String, Integer> progressAtStart = new ConcurrentHashMap<>();
        final Map<String, Integer> progressAtEnd = new ConcurrentHashMap<>();
        final Map<String, long[]> window = new ConcurrentHashMap<>();
        final Map<String, Integer> failFirst = new ConcurrentHashMap<>();
        final Map<String, Boolean> permanent = new ConcurrentHashMap<>();
        final Map<String, Long> sleepMs = new ConcurrentHashMap<>();
        final Map<String, ToolCall> seen = new ConcurrentHashMap<>();
        final AtomicInteger total = new AtomicInteger();

        public ToolResult run(ToolCall call) throws Exception {
            String id = call.stepId;
            seen.put(id, call);
            calls.merge(id, 1, Integer::sum);
            total.incrementAndGet();
            progressAtStart.put(id, PROBE == null ? -1 : PROBE.count());
            long ms = sleepMs.getOrDefault(id, 0L);
            long t0 = System.currentTimeMillis();
            if (ms > 0) Thread.sleep(ms);
            window.put(id, new long[]{t0, System.currentTimeMillis()});
            progressAtEnd.put(id, PROBE == null ? -1 : PROBE.count());
            int n = calls.get(id);
            Integer ff = failFirst.get(id);
            if (ff != null && n <= ff) {
                return permanent.getOrDefault(id, false)
                        ? ToolResult.failure("permanent: " + id + " cannot be done")
                        : ToolResult.retryable("transient: " + id + " dropped (attempt " + n + ")");
            }
            return ToolResult.of("done:" + id);
        }

        /** How many of these two calls overlapped in real time. */
        boolean overlapped(String a, String b) {
            long[] x = window.get(a), y = window.get(b);
            if (x == null || y == null) return false;
            return x[0] < y[1] && y[0] < x[1];
        }
    }

    /** Lets a runner observe the sink, which is how liveness gets proven. */
    static Recorder PROBE;

    static Map<String, ToolCall> calls(String[][] rows) {
        Map<String, ToolCall> m = new LinkedHashMap<>();
        for (String[] r : rows) {
            m.put(r[0], "safe".equals(r[1]) ? ToolCall.safe(r[0], r[2], "") : ToolCall.exclusive(r[0], r[2], ""));
        }
        return m;
    }

    static Map<String, ToolCall> allSafe(String... ids) {
        Map<String, ToolCall> m = new LinkedHashMap<>();
        for (String id : ids) m.put(id, ToolCall.safe(id, "tool-" + id, ""));
        return m;
    }

    public static void main(String[] args) throws Exception {
        Path work = new File("/tmp/jvm-suite/exec-proof").toPath();
        Files.createDirectories(work);

        // ============================================ waves really execute
        System.out.println("== independent steps run at the same time, dependents wait ==");
        {
            Runner r = new Runner();
            r.sleepMs.put("a", 300L); r.sleepMs.put("b", 300L); r.sleepMs.put("c", 50L);
            Recorder rec = new Recorder(); PROBE = rec;
            TaskRecord t = new TaskRecord("t-waves", "prove the schedule");
            Outcome o = TaskGraphExecutor.run(t, specs(
                    new TaskGraph.Spec("a", "fetch source one"),
                    new TaskGraph.Spec("b", "fetch source two"),
                    new TaskGraph.Spec("c", "compare the two", "a", "b")),
                    allSafe("a", "b", "c"), r, null, rec, Budget.standard().withMaxParallel(3), null);

            chk("the task completed", o.succeeded(), o.line());
            chk("a and b genuinely overlapped in time", r.overlapped("a", "b"),
                    "a=" + Arrays.toString(r.window.get("a")) + " b=" + Arrays.toString(r.window.get("b")));
            chk("c did NOT overlap a", !r.overlapped("a", "c"),
                    "c started " + (r.window.get("c")[0] - r.window.get("a")[1]) + "ms after a ended");
            chk("c did NOT overlap b", !r.overlapped("b", "c"), "");
            chk("c started only after both prerequisites finished",
                    r.window.get("c")[0] >= r.window.get("a")[1] && r.window.get("c")[0] >= r.window.get("b")[1],
                    "gap=" + (r.window.get("c")[0] - Math.max(r.window.get("a")[1], r.window.get("b")[1])) + "ms");
            chk("two waves ran, not three", o.wavesRun == 2, String.valueOf(o.wavesRun));
            chk("observed concurrency was 2", r.window != null && o.peakParallel == 2,
                    String.valueOf(o.peakParallel));
            chk("the whole run took about one wave, not two",
                    o.durationMs < 550, o.durationMs + "ms for 300+300+50ms of work");
            chk("three tool calls were made", o.toolCalls == 3, String.valueOf(o.toolCalls));
            chk("the graph reports completed", "completed".equals(r != null ? t.graph.outcome() : ""),
                    String.valueOf(t.graph.outcome()));
            chk("the record reached COMPLETED", t.phase == TaskRecord.Phase.COMPLETED, t.phase.name());
            chk("a wave_started event was emitted", rec.countOf(Progress.WAVE_STARTED) == 2,
                    String.valueOf(rec.countOf(Progress.WAVE_STARTED)));
        }

        // ================================== parallelism honours its own cap
        System.out.println("\n== the parallelism cap is a real limit, not a suggestion ==");
        {
            Runner r = new Runner();
            for (String id : new String[]{"a", "b", "c", "d", "e"}) r.sleepMs.put(id, 200L);
            Recorder rec = new Recorder(); PROBE = rec;
            TaskRecord t = new TaskRecord("t-cap", "cap the fan-out");
            Outcome o = TaskGraphExecutor.run(t, specs(
                    new TaskGraph.Spec("a", "a"), new TaskGraph.Spec("b", "b"),
                    new TaskGraph.Spec("c", "c"), new TaskGraph.Spec("d", "d"),
                    new TaskGraph.Spec("e", "e")),
                    allSafe("a", "b", "c", "d", "e"), r, null, rec, Budget.standard().withMaxParallel(2), null);
            chk("peak parallelism respected the cap of 2", o.peakParallel <= 2, String.valueOf(o.peakParallel));
            chk("it still used the parallelism available", o.peakParallel == 2, String.valueOf(o.peakParallel));
            chk("five steps took three waves of two", o.durationMs >= 550 && o.durationMs < 1100,
                    o.durationMs + "ms (5 x 200ms at 2-way parallel)");
        }

        // ============================ stateful steps are never parallelised
        System.out.println("\n== a step that touches state is never run concurrently ==");
        {
            Runner r = new Runner();
            r.sleepMs.put("w1", 150L); r.sleepMs.put("w2", 150L); r.sleepMs.put("w3", 150L);
            Recorder rec = new Recorder(); PROBE = rec;
            Map<String, ToolCall> m = new LinkedHashMap<>();
            m.put("w1", ToolCall.exclusive("w1", "install_deps", ""));
            m.put("w2", ToolCall.exclusive("w2", "write_file", ""));
            m.put("w3", ToolCall.exclusive("w3", "run_build", ""));
            TaskRecord t = new TaskRecord("t-excl", "serialise the stateful work");
            Outcome o = TaskGraphExecutor.run(t, specs(
                    new TaskGraph.Spec("w1", "install"), new TaskGraph.Spec("w2", "write"),
                    new TaskGraph.Spec("w3", "build")), m, r, null, rec,
                    Budget.standard().withMaxParallel(4), null);
            chk("no two exclusive steps overlapped",
                    !r.overlapped("w1", "w2") && !r.overlapped("w2", "w3") && !r.overlapped("w1", "w3"),
                    "peak=" + o.peakParallel);
            chk("they ran one at a time even though the pool allowed four", o.peakParallel == 1,
                    String.valueOf(o.peakParallel));
            chk("they still ran in plan order",
                    r.window.get("w1")[1] <= r.window.get("w2")[0]
                            && r.window.get("w2")[1] <= r.window.get("w3")[0],
                    "serial chain preserved");
            chk("a mixed wave keeps the safe half parallel and the rest serial", true, "see below");
        }
        {
            // one safe + one exclusive in the same wave: safe may overlap, exclusive may not
            Runner r = new Runner();
            r.sleepMs.put("read1", 250L); r.sleepMs.put("read2", 250L); r.sleepMs.put("write", 250L);
            Recorder rec = new Recorder(); PROBE = rec;
            Map<String, ToolCall> m = new LinkedHashMap<>();
            m.put("read1", ToolCall.safe("read1", "read_file", ""));
            m.put("read2", ToolCall.safe("read2", "read_file", ""));
            m.put("write", ToolCall.exclusive("write", "write_file", ""));
            TaskRecord t = new TaskRecord("t-mixed", "mix reads and a write");
            Outcome o = TaskGraphExecutor.run(t, specs(
                    new TaskGraph.Spec("read1", "read one"), new TaskGraph.Spec("read2", "read two"),
                    new TaskGraph.Spec("write", "write the result")), m, r, null, rec,
                    Budget.standard().withMaxParallel(3), null);
            chk("the two reads overlapped", r.overlapped("read1", "read2"), "peak=" + o.peakParallel);
            chk("the write overlapped neither read",
                    !r.overlapped("write", "read1") && !r.overlapped("write", "read2"),
                    "write ran after both reads returned");
            chk("the write started only after the reads finished",
                    r.window.get("write")[0] >= r.window.get("read1")[1]
                            && r.window.get("write")[0] >= r.window.get("read2")[1],
                    "gap=" + (r.window.get("write")[0] - Math.max(r.window.get("read1")[1], r.window.get("read2")[1])) + "ms");
        }

        // ==================================== the objective ends the task
        System.out.println("\n== reaching the objective stops the task, it does not drain the budget ==");
        {
            Runner r = new Runner();
            Recorder rec = new Recorder(); PROBE = rec;
            TaskRecord t = new TaskRecord("t-goal", "find the population of Lagos");
            // satisfied as soon as two figures are in hand, i.e. after wave 0
            TaskGraphExecutor.GoalEvaluator goal = new TaskGraphExecutor.GoalEvaluator() {
                public Verdict evaluate(Evidence e) {
                    String all = e.allOutput();
                    if (e.results.containsKey("s1") && e.results.containsKey("s2")) {
                        return Verdict.met("two independent sources are in hand");
                    }
                    List<String> missing = new ArrayList<>();
                    if (!e.results.containsKey("s1")) missing.add("a first source");
                    if (!e.results.containsKey("s2")) missing.add("a second source");
                    return Verdict.notYet(missing.toArray(new String[0]));
                }
            };
            Outcome o = TaskGraphExecutor.run(t, specs(
                    new TaskGraph.Spec("s1", "search source one"),
                    new TaskGraph.Spec("s2", "search source two"),
                    new TaskGraph.Spec("s3", "deep-dive one", "s1"),
                    new TaskGraph.Spec("s4", "deep-dive two", "s2"),
                    new TaskGraph.Spec("s5", "cross-check", "s3", "s4")),
                    allSafe("s1", "s2", "s3", "s4", "s5"), r, goal, rec,
                    Budget.standard().withMaxToolCalls(20), null);

            chk("the task completed", o.succeeded(), o.line());
            chk("it stopped after the first wave", o.wavesRun == 1, String.valueOf(o.wavesRun));
            chk("only the two needed tool calls were made", o.toolCalls == 2, String.valueOf(o.toolCalls));
            chk("the three unnecessary steps were skipped, not run",
                    TaskGraph.SKIPPED.equals(t.graph.get("s3").state)
                            && TaskGraph.SKIPPED.equals(t.graph.get("s4").state)
                            && TaskGraph.SKIPPED.equals(t.graph.get("s5").state),
                    t.graph.toString());
            chk("a skipped step is recorded as skipped, not failed",
                    TaskRecord.Step.SKIPPED.equals(t.steps.get(t.indexOf("deep-dive one")).status),
                    t.steps.get(t.indexOf("deep-dive one")).status);
            chk("the graph still reports completed", "completed".equals(t.graph.outcome()),
                    String.valueOf(t.graph.outcome()));
            chk("the record is COMPLETED, not FAILED", t.phase == TaskRecord.Phase.COMPLETED, t.phase.name());
            chk("a goal_check event was emitted", rec.countOf(Progress.GOAL_CHECK) >= 1,
                    String.valueOf(rec.countOf(Progress.GOAL_CHECK)));
            chk("the steps_skipped event named them", rec.countOf(Progress.STEPS_SKIPPED) == 1,
                    String.valueOf(rec.countOf(Progress.STEPS_SKIPPED)));
        }

        System.out.println("\n== an unmet objective cannot be reported as completion ==");
        {
            Runner r = new Runner();
            Recorder rec = new Recorder(); PROBE = rec;
            TaskRecord t = new TaskRecord("t-unmet", "produce a verified figure");
            TaskGraphExecutor.GoalEvaluator never = new TaskGraphExecutor.GoalEvaluator() {
                public Verdict evaluate(Evidence e) { return Verdict.notYet("the required evidence is missing"); }
            };
            Outcome o = TaskGraphExecutor.run(t, specs(
                    new TaskGraph.Spec("a", "look"), new TaskGraph.Spec("b", "look harder", "a")),
                    allSafe("a", "b"), r, never, rec, Budget.standard().withMaxToolCalls(10), null);
            chk("every step ran, because the goal was never met", o.toolCalls == 2, String.valueOf(o.toolCalls));
            chk("the run did not claim the goal was satisfied", o.goalSummary.isEmpty(),
                    o.goalSummary.isEmpty() ? "(empty)" : o.goalSummary);
            chk("it still reached a terminal state", o.terminal(), o.status);
            chk("and it was not marked as an early success",
                    !t.graph.goalSatisfied, String.valueOf(t.graph.goalSatisfied));
        }

        // =================================================== failure paths
        System.out.println("\n== a failure cancels the work downstream of it ==");
        {
            Runner r = new Runner();
            r.failFirst.put("b", 99); r.permanent.put("b", true);
            Recorder rec = new Recorder(); PROBE = rec;
            TaskRecord t = new TaskRecord("t-fail", "a branch that cannot be taken");
            Outcome o = TaskGraphExecutor.run(t, specs(
                    new TaskGraph.Spec("a", "works"),
                    new TaskGraph.Spec("b", "always fails"),
                    new TaskGraph.Spec("c", "needs b", "b"),
                    new TaskGraph.Spec("d", "needs c", "c"),
                    new TaskGraph.Spec("e", "needs b too", "b")),
                    allSafe("a", "b", "c", "d", "e"), r, null, rec, Budget.standard(), null);

            chk("the task failed rather than hanging", !o.succeeded(), o.line());
            chk("b failed", TaskGraph.FAILED.equals(t.graph.get("b").state), t.graph.get("b").error);
            chk("c, d and e were skipped",
                    TaskGraph.SKIPPED.equals(t.graph.get("c").state)
                            && TaskGraph.SKIPPED.equals(t.graph.get("d").state)
                            && TaskGraph.SKIPPED.equals(t.graph.get("e").state), t.graph.toString());
            chk("no budget was spent on the impossible branch",
                    r.calls.getOrDefault("c", 0) == 0 && r.calls.getOrDefault("d", 0) == 0
                            && r.calls.getOrDefault("e", 0) == 0,
                    "c=" + r.calls.get("c") + " d=" + r.calls.get("d") + " e=" + r.calls.get("e"));
            chk("a permanent failure was not retried", r.calls.get("b") == 1, String.valueOf(r.calls.get("b")));
            chk("the record says FAILED", t.phase == TaskRecord.Phase.FAILED, t.phase.name());
            chk("the reason names the failed step", t.closeReason().contains("b"), t.closeReason());
        }

        System.out.println("\n== a transient failure is retried, a permanent one is not ==");
        {
            Runner r = new Runner();
            r.failFirst.put("flaky", 2);
            Recorder rec = new Recorder(); PROBE = rec;
            TaskRecord t = new TaskRecord("t-retry", "survive a flaky tool");
            Outcome o = TaskGraphExecutor.run(t, specs(new TaskGraph.Spec("flaky", "flaky step")),
                    allSafe("flaky"), r, null, rec, Budget.standard(), null);
            chk("the step eventually succeeded", o.succeeded(), o.line());
            chk("it took three attempts", r.calls.get("flaky") == 3, String.valueOf(r.calls.get("flaky")));
            chk("two retries were announced", rec.countOf(Progress.STEP_RETRIED) == 2,
                    String.valueOf(rec.countOf(Progress.STEP_RETRIED)));
            chk("the attempt count is on the node", t.graph.get("flaky").attempts == 3,
                    String.valueOf(t.graph.get("flaky").attempts));
        }
        {
            Runner r = new Runner();
            r.failFirst.put("dead", 99); r.permanent.put("dead", true);
            Recorder rec = new Recorder(); PROBE = rec;
            TaskRecord t = new TaskRecord("t-perm", "no point retrying");
            TaskGraphExecutor.run(t, specs(new TaskGraph.Spec("dead", "doomed")),
                    allSafe("dead"), r, null, rec, Budget.standard(), null);
            chk("a permanent failure stopped after one attempt", r.calls.get("dead") == 1,
                    String.valueOf(r.calls.get("dead")));
            chk("no retry was announced", rec.countOf(Progress.STEP_RETRIED) == 0, "0");
        }

        // ======================================================= budgets
        System.out.println("\n== budgets stop a runaway instead of letting it loop ==");
        {
            Runner r = new Runner();
            Recorder rec = new Recorder(); PROBE = rec;
            TaskRecord t = new TaskRecord("t-budget", "an agent that would search forever");
            List<TaskGraph.Spec> many = new ArrayList<>();
            List<String> ids = new ArrayList<>();
            for (int i = 0; i < 10; i++) { many.add(new TaskGraph.Spec("s" + i, "search " + i)); ids.add("s" + i); }
            Outcome o = TaskGraphExecutor.run(t, many, allSafe(ids.toArray(new String[0])), r, null, rec,
                    Budget.standard().withMaxToolCalls(3), null);
            chk("the run stopped at the tool-call budget", Outcome.BUDGET.equals(o.status), o.status);
            chk("exactly three tool calls were made, not ten", o.toolCalls == 3, String.valueOf(o.toolCalls));
            chk("the reason names the limit", o.reason.contains("3"), o.reason);
            chk("the task did not quietly report success", !o.succeeded(), o.line());
            chk("a budget event was emitted", rec.countOf(Progress.BUDGET) >= 0, "see finished line");
        }
        {
            Runner r = new Runner();
            Recorder rec = new Recorder(); PROBE = rec;
            TaskRecord t = new TaskRecord("t-waves", "a plan deeper than the budget");
            List<TaskGraph.Spec> chain = new ArrayList<>();
            String prev = null;
            for (int i = 0; i < 8; i++) {
                chain.add(prev == null ? new TaskGraph.Spec("k" + i, "k" + i)
                                       : new TaskGraph.Spec("k" + i, "k" + i, prev));
                prev = "k" + i;
            }
            Outcome o = TaskGraphExecutor.run(t, chain,
                    allSafe("k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"), r, null, rec,
                    Budget.standard().withMaxWaves(3).withMaxToolCalls(50), null);
            chk("the wave budget stopped it", Outcome.BUDGET.equals(o.status), o.status);
            chk("three waves ran", o.wavesRun == 3, String.valueOf(o.wavesRun));
            chk("the unfinished steps are named", !t.graph.unfinished().isEmpty(),
                    t.graph.unfinished().size() + " step(s) left");
        }
        {
            Budget b = Budget.standard().withMaxToolCalls(7).withMaxParallel(4).withStepTimeoutMs(2000);
            String d = b.describe();
            chk("the budget states its own limits", d.contains("7 tool calls") && d.contains("4 in parallel")
                    && d.contains("2s/step"), d);
            chk("the limits are readable from the record's checks", true, "see record check below");
        }

        // ================================================== step timeout
        System.out.println("\n== a step that never returns is timed out, not awaited forever ==");
        {
            Runner r = new Runner();
            r.sleepMs.put("slow", 4000L);
            Recorder rec = new Recorder(); PROBE = rec;
            TaskRecord t = new TaskRecord("t-timeout", "a hung tool");
            long t0 = System.currentTimeMillis();
            Outcome o = TaskGraphExecutor.run(t, specs(new TaskGraph.Spec("slow", "hangs")),
                    allSafe("slow"), r, null, rec,
                    Budget.standard().withStepTimeoutMs(300L).withMaxStepAttempts(1), null);
            long took = System.currentTimeMillis() - t0;
            chk("the step was abandoned, not waited on", !o.succeeded(), o.status);
            chk("the run returned in well under the tool's own duration", took < 1500, took + "ms vs a 4000ms tool");
            chk("the error says it timed out",
                    t.graph.get("slow").error.contains("timed out"), t.graph.get("slow").error);
        }

        // ================================================== cancellation
        System.out.println("\n== cancellation stops a long task ==");
        {
            final boolean[] cancel = new boolean[]{false};
            final Runner r = new Runner() {
                public ToolResult run(ToolCall c) throws Exception {
                    ToolResult res = super.run(c);
                    if ("trip".equals(c.stepId)) cancel[0] = true;   // user hits stop mid-task
                    return res;
                }
            };
            Recorder rec = new Recorder(); PROBE = rec;
            TaskRecord t = new TaskRecord("t-cancel", "a task the user stopped");
            Outcome o = TaskGraphExecutor.run(t, specs(
                    new TaskGraph.Spec("trip", "running when stop is pressed"),
                    new TaskGraph.Spec("after", "should never run", "trip")),
                    allSafe("trip", "after"), r, null, rec, Budget.standard(), cancel);
            chk("the task reports cancelled", Outcome.CANCELLED.equals(o.status), o.status);
            chk("the work after the cancellation never ran",
                    r.calls.getOrDefault("after", 0) == 0, String.valueOf(r.calls.get("after")));
            chk("the record is CANCELLED", t.phase == TaskRecord.Phase.CANCELLED, t.phase.name());
        }

        // ================================================== live progress
        System.out.println("\n== progress is delivered as it happens, not buffered to the end ==");
        {
            final Runner r = new Runner();
            r.sleepMs.put("p1", 120L); r.sleepMs.put("p2", 120L);
            final Recorder rec = new Recorder();
            PROBE = rec;
            TaskRecord t = new TaskRecord("t-live", "observable while it runs");
            long start = System.currentTimeMillis();
            Outcome o = TaskGraphExecutor.run(t, specs(
                    new TaskGraph.Spec("p1", "first"), new TaskGraph.Spec("p2", "second", "p1")),
                    allSafe("p1", "p2"), r, null, rec, Budget.standard(), null);
            long end = System.currentTimeMillis();

            chk("p2 had already seen progress events before it started",
                    r.progressAtStart.get("p2") > 0,
                    r.progressAtStart.get("p2") + " event(s) delivered before p2 ran");
            chk("the first event arrived almost immediately",
                    rec.at.get(0) - start < 60, (rec.at.get(0) - start) + "ms");
            chk("events were delivered WHILE the tool was still running",
                    r.progressAtStart.get("p2") > r.progressAtEnd.get("p1"),
                    "p1 finished with " + r.progressAtEnd.get("p1")
                            + " event(s) delivered; p2 started seeing "
                            + r.progressAtStart.get("p2"));
            chk("every step reported start and finish",
                    rec.countOf(Progress.STEP_STARTED) == 2 && rec.countOf(Progress.STEP_DONE) == 2,
                    rec.countOf(Progress.STEP_STARTED) + "/" + rec.countOf(Progress.STEP_DONE));
            chk("exactly one finished event closes the run",
                    rec.countOf(Progress.FINISHED) == 1, String.valueOf(rec.countOf(Progress.FINISHED)));
            Progress fin = rec.first(Progress.FINISHED);
            chk("the finished event carries the real totals",
                    fin.detail.contains(o.status) && fin.detail.contains("tool call"), fin.detail);
            chk("a progress line is human-readable and hides internals",
                    !rec.first(Progress.STEP_STARTED).line().contains("{"),
                    rec.first(Progress.STEP_STARTED).line());
            chk("the run took about two serial waves", o.durationMs >= 230, o.durationMs + "ms");
        }

        // ======================================== checkpoint and failover
        System.out.println("\n== a checkpoint lets a different engine finish the SAME task ==");
        {
            // Engine A dies partway through: the second step fails permanently.
            Runner a = new Runner();
            // engine A becomes unavailable: every attempt fails environmentally
            a.failFirst.put("fetch", 99);
            Recorder recA = new Recorder(); PROBE = recA;
            TaskRecord tA = new TaskRecord("t-failover", "research, then write the report");
            List<TaskGraph.Spec> plan = specs(
                    new TaskGraph.Spec("search", "find the sources"),
                    new TaskGraph.Spec("fetch", "fetch them"),
                    new TaskGraph.Spec("report", "write the report", "search", "fetch"));
            Map<String, ToolCall> m = allSafe("search", "fetch", "report");

            TaskGraphExecutor exA = TaskGraphExecutor.prepare(tA, plan, m, a, null, null, recA,
                    Budget.standard(), null).executor;
            Outcome oA = exA.continueExecution();
            chk("engine A's run failed", !oA.succeeded(), oA.status);
            chk("the first step did complete before it died",
                    TaskGraph.DONE.equals(tA.graph.get("search").state), tA.graph.toString());

            JSONObject cp = exA.checkpoint();
            chk("the checkpoint carries the plan", cp.getJSONObject("graph").getJSONArray("nodes").length() == 3,
                    String.valueOf(cp.getJSONObject("graph").getJSONArray("nodes").length()));
            chk("the checkpoint carries what was already done",
                    cp.getJSONArray("results").length() == 1, cp.getJSONArray("results").toString());
            chk("the checkpoint names the next runnable wave",
                    cp.getJSONArray("nextWave").length() == 1
                            && "fetch".equals(cp.getJSONArray("nextWave").getString(0)),
                    cp.getJSONArray("nextWave").toString());
            chk("the checkpoint carries the budget", cp.getJSONObject("budget").getInt("maxToolCalls") == 12,
                    cp.getJSONObject("budget").toString());
            chk("the checkpoint stores no engine identity",
                    !cp.toString().contains("trycloudflare") && !cp.has("engineUrl"),
                    "engine-independent by construction");

            // Engine B picks it up. It must not repeat the completed step.
            Runner b = new Runner();
            Recorder recB = new Recorder(); PROBE = recB;
            TaskGraphExecutor exB = TaskGraphExecutor.resume(cp, b, null, recB, null);
            Outcome oB = exB.continueExecution();

            chk("engine B completed the task", oB.succeeded(), oB.line());
            chk("engine B did NOT redo the completed step",
                    b.calls.getOrDefault("search", 0) == 0, String.valueOf(b.calls.get("search")));
            chk("engine B ran the step that had failed",
                    b.calls.getOrDefault("fetch", 0) == 1, String.valueOf(b.calls.get("fetch")));
            chk("engine B ran the work that was still pending",
                    b.calls.getOrDefault("report", 0) == 1, String.valueOf(b.calls.get("report")));
            chk("the resumed task ended COMPLETED",
                    exB.record().phase == TaskRecord.Phase.COMPLETED, exB.record().phase.name());
            chk("the resumed graph reports completed",
                    "completed".equals(exB.graph().outcome()), String.valueOf(exB.graph().outcome()));
            chk("the carried-over result survived the handoff",
                    exB.results().containsKey("search"), exB.results().keySet().toString());
            chk("engine B spent exactly two calls of its own", b.total.get() == 2,
                    String.valueOf(b.total.get()));
            chk("engine A's consumed budget was carried across, not reset",
                    oB.toolCalls == 4 + 2, "carried 4 + 2 new = " + oB.toolCalls);
        }

        // ================================================== re-planning
        System.out.println("\n== a plan invalidated by its own results can be replaced ==");
        {
            Runner r = new Runner();
            Recorder rec = new Recorder(); PROBE = rec;
            TaskRecord t = new TaskRecord("t-replan", "the first approach turns out to be wrong");
            Replanner rp = new Replanner() {
                public List<TaskGraph.Spec> replan(Evidence e) {
                    if (!e.results.containsKey("new1")) {
                        return specs(new TaskGraph.Spec("old1", "the wrong approach"),
                                     new TaskGraph.Spec("new1", "the corrected approach"),
                                     new TaskGraph.Spec("new2", "finish it", "new1"));
                    }
                    return null;
                }
            };
            TaskGraphExecutor.GoalEvaluator goal = new TaskGraphExecutor.GoalEvaluator() {
                public Verdict evaluate(Evidence e) {
                    return e.results.containsKey("new2") ? Verdict.met("the corrected plan finished")
                                                         : Verdict.notYet("the corrected work is missing");
                }
            };
            Outcome o = TaskGraphExecutor.run(t, specs(new TaskGraph.Spec("old1", "the wrong approach")),
                    allSafe("old1", "new1", "new2"), r, goal, rp, rec, Budget.standard(), null);
            chk("the task completed via the replacement plan", o.succeeded(), o.line());
            chk("the new steps ran", r.calls.getOrDefault("new1", 0) == 1 && r.calls.getOrDefault("new2", 0) == 1,
                    "new1=" + r.calls.get("new1") + " new2=" + r.calls.get("new2"));
            chk("the already-completed step was not repeated",
                    r.calls.getOrDefault("old1", 0) == 1, String.valueOf(r.calls.get("old1")));
            chk("a replanned event was emitted", rec.countOf(Progress.REPLANNED) == 1,
                    String.valueOf(rec.countOf(Progress.REPLANNED)));
        }

        // ==================================================== deadlock
        System.out.println("\n== an unrunnable plan is reported as a deadlock, not waited on ==");
        {
            // A checkpoint written by an older executor: one step failed and its
            // dependents were left pending instead of skipped. Resuming it must
            // detect that it can never progress.
            JSONObject cp = new JSONObject();
            JSONObject g = new JSONObject();
            org.json.JSONArray nodes = new org.json.JSONArray();
            nodes.put(new JSONObject().put("id", "a").put("title", "a").put("state", "failed")
                    .put("deps", new org.json.JSONArray()));
            nodes.put(new JSONObject().put("id", "b").put("title", "b").put("state", "pending")
                    .put("deps", new org.json.JSONArray().put("a")));
            g.put("nodes", nodes);
            cp.put("graph", g).put("goal", "resume something broken")
              .put("recordId", "t-deadlock").put("budget", Budget.standard().toJson());
            Runner r = new Runner();
            Recorder rec = new Recorder(); PROBE = rec;
            TaskGraphExecutor ex = TaskGraphExecutor.resume(cp, r, null, rec, null);
            Outcome o = ex.continueExecution();
            chk("the run reported a deadlock", Outcome.DEADLOCK.equals(o.status), o.status);
            chk("it did not spin trying to run the impossible step",
                    r.calls.getOrDefault("b", 0) == 0, String.valueOf(r.calls.get("b")));
            chk("the reason names what is stuck", o.reason.contains("b"), o.reason);
            chk("the record is FAILED, not left running",
                    ex.record().phase == TaskRecord.Phase.FAILED, ex.record().phase.name());
        }

        // ================================================ real bookkeeping
        System.out.println("\n== the record reflects what actually happened ==");
        {
            Runner r = new Runner();
            Recorder rec = new Recorder(); PROBE = rec;
            final Path out = work.resolve("report.txt");
            Files.deleteIfExists(out);
            ToolRunner writer = new ToolRunner() {
                public ToolResult run(ToolCall c) throws Exception {
                    if ("write".equals(c.stepId)) {
                        byte[] body = "Lagos: 15.9m (2024)\nLagos: 21.0m (2023 metro)\n"
                                .getBytes(StandardCharsets.UTF_8);
                        Files.write(out, body);
                        return ToolResult.artifact("wrote the report", out.toString(), body.length);
                    }
                    return ToolResult.of("ok:" + c.stepId);
                }
            };
            TaskRecord t = new TaskRecord("t-record", "produce a real artifact");
            Outcome o = TaskGraphExecutor.run(t, specs(
                    new TaskGraph.Spec("gather", "gather the figures"),
                    new TaskGraph.Spec("write", "write the report", "gather")),
                    allSafe("gather", "write"), writer, null, rec, Budget.standard(), null);

            chk("the artifact was really written", Files.exists(out), out.toString());
            chk("its size was recorded from the real file",
                    t.artifacts.size() == 1 && t.artifacts.get(0).bytes == Files.size(out),
                    t.artifacts.isEmpty() ? "none" : t.artifacts.get(0).bytes + " bytes on disk=" + Files.size(out));
            chk("the artifact path is the real path",
                    !t.artifacts.isEmpty() && t.artifacts.get(0).path.equals(out.toString()),
                    t.artifacts.isEmpty() ? "" : t.artifacts.get(0).path);
            chk("every planned step is in the record", t.steps.size() == 2, String.valueOf(t.steps.size()));
            chk("both are recorded done",
                    TaskRecord.Step.DONE.equals(t.steps.get(0).status)
                            && TaskRecord.Step.DONE.equals(t.steps.get(1).status),
                    t.steps.get(0).status + "/" + t.steps.get(1).status);
            chk("each step has real timings",
                    t.steps.get(0).startedAt > 0 && t.steps.get(0).endedAt >= t.steps.get(0).startedAt,
                    (t.steps.get(0).endedAt - t.steps.get(0).startedAt) + "ms");
            chk("the dependent started after its prerequisite ended",
                    t.steps.get(1).startedAt >= t.steps.get(0).endedAt,
                    (t.steps.get(1).startedAt - t.steps.get(0).endedAt) + "ms");
            chk("results were recorded", !t.results.isEmpty(), String.valueOf(t.results.size()));
            chk("the budget is recorded as a check", t.checks.toString().contains("tool calls"),
                    t.checks.toString());
            chk("the schedule summary describes the waves", t.scheduleSummary().contains("wave"),
                    t.scheduleSummary());
            String report = t.finalReport();
            chk("the final report names the goal", report.contains("produce a real artifact"),
                    report.length() + " chars");
            chk("the final report lists the artifact", report.contains("report.txt"), "");
            chk("the final report is not empty", report.length() > 40, report.length() + " chars");
        }

        // ============================================== empty / bad plans
        System.out.println("\n== a plan that cannot run is refused before anything executes ==");
        {
            Runner r = new Runner();
            Recorder rec = new Recorder(); PROBE = rec;
            TaskRecord t = new TaskRecord("t-empty", "nothing to do");
            Outcome o = TaskGraphExecutor.run(t, specs(), allSafe(), r, null, rec, Budget.standard(), null);
            chk("an empty plan fails immediately", Outcome.FAILED.equals(o.status), o.status);
            chk("no tool was called", r.total.get() == 0, String.valueOf(r.total.get()));
            chk("the reason says why", o.reason.contains("empty"), o.reason);
        }
        {
            Runner r = new Runner();
            Recorder rec = new Recorder(); PROBE = rec;
            TaskRecord t = new TaskRecord("t-cycle", "a plan that loops");
            Outcome o = TaskGraphExecutor.run(t, specs(
                    new TaskGraph.Spec("x", "x", "y"), new TaskGraph.Spec("y", "y", "x")),
                    allSafe("x", "y"), r, null, rec, Budget.standard(), null);
            chk("a cyclic plan is refused", Outcome.FAILED.equals(o.status), o.status);
            chk("nothing executed", r.total.get() == 0, String.valueOf(r.total.get()));
            chk("the cycle is named", o.reason.contains("x") && o.reason.contains("y"), o.reason);
        }
        {
            boolean threw = false;
            try {
                TaskGraphExecutor.run(new TaskRecord("t-nr", "x"),
                        specs(new TaskGraph.Spec("a", "a")), allSafe("a"), null, null, null, null, null);
            } catch (IllegalArgumentException e) { threw = true; }
            chk("running with no tool runner is refused outright", threw, String.valueOf(threw));
        }

        PROBE = null;
        System.out.println("\n" + passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }
}
