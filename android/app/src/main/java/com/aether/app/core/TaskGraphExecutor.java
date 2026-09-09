package com.aether.app.core;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Executes a {@link TaskGraph}: wave by wave, independent steps at the same
 * time, dependents only after their prerequisites have finished.
 *
 * <p>The graph on its own is a schedule that nobody runs. Without this class a
 * plan is decorative: an agent that wants a result either runs the steps in
 * written order (no parallelism, and a dependency is honoured by luck) or it
 * keeps calling tools until something looks like an answer. The measured
 * failure this exists to fix is the second one -- a research goal that made
 * ~10 tool calls over 18 minutes and then reported "I hit my tool-step limit
 * before writing the final answer", with no figures and no sources. Tools were
 * never the problem. Convergence was.
 *
 * <p>So three things are enforced here rather than hoped for:
 * <ol>
 *   <li><b>Budgets.</b> Step attempts, tool calls, waves and wall-clock time all
 *       have limits that are configurable and printable ({@link Budget#describe}).
 *       A limit that lives in a caller is a limit a caller walks past.</li>
 *   <li><b>A goal check after every wave.</b> The objective, not the plan, decides
 *       when to stop. If the answer is already in hand the executor stops and
 *       skips what is left; if required evidence is still missing it is not
 *       allowed to call the task complete.</li>
 *   <li><b>Terminal truth.</b> Every run ends in exactly one status, and a run
 *       that could not finish says why instead of falling off the end of a loop.</li>
 * </ol>
 *
 * <p>The executor is deliberately ignorant of engines. It takes a
 * {@link ToolRunner} and knows nothing about Kaggle, tunnels or models, so a
 * task interrupted mid-flight can be written out with {@link #checkpoint} and
 * resumed on a different engine with {@link #resume} without starting again.
 */
public final class TaskGraphExecutor {

    // ============================================================ contracts

    /** One tool invocation. The executor never touches a tool any other way. */
    public static final class ToolCall {
        public final String stepId;
        public final String tool;
        public final String args;
        /**
         * Whether this call may overlap with other calls.
         *
         * Reads, searches and fetches are safe. Anything that writes a file,
         * spawns a process or mutates shared state is not: two of those running
         * at once is a race the plan never asked for. The default is false, so
         * forgetting to mark something leaves it serial rather than corrupted.
         */
        public final boolean parallelSafe;

        public ToolCall(String stepId, String tool, String args, boolean parallelSafe) {
            this.stepId = stepId == null ? "" : stepId;
            this.tool = tool == null ? "" : tool;
            this.args = args == null ? "" : args;
            this.parallelSafe = parallelSafe;
        }

        public static ToolCall safe(String stepId, String tool, String args) {
            return new ToolCall(stepId, tool, args, true);
        }

        public static ToolCall exclusive(String stepId, String tool, String args) {
            return new ToolCall(stepId, tool, args, false);
        }
    }

    /** What a tool returned. */
    public static final class ToolResult {
        public final boolean ok;
        public final String output;
        public final String error;
        /** True when the same call is worth making again. Drives the retry. */
        public final boolean transientFailure;
        /** Set when the call produced something that should be kept. */
        public final String artifactPath;
        public final String artifactChange;
        public final long artifactBytes;
        public long elapsedMs;

        private ToolResult(boolean ok, String output, String error, boolean trans,
                           String path, String change, long bytes) {
            this.ok = ok;
            this.output = output == null ? "" : output;
            this.error = error == null ? "" : error;
            this.transientFailure = trans;
            this.artifactPath = path == null ? "" : path;
            this.artifactChange = change == null ? "" : change;
            this.artifactBytes = bytes;
        }

        public static ToolResult of(String output) { return new ToolResult(true, output, "", false, "", "", 0); }
        public static ToolResult artifact(String output, String path, long bytes) {
            return new ToolResult(true, output, "", false, path, "created", bytes);
        }
        public static ToolResult failure(String error) { return new ToolResult(false, "", error, false, "", "", 0); }
        /** A failure worth another attempt: timeouts, refusals, tunnels that dropped. */
        public static ToolResult retryable(String error) { return new ToolResult(false, "", error, true, "", "", 0); }

        public boolean hasArtifact() { return !artifactPath.isEmpty(); }
    }

    /** Runs one tool call. Implemented by whatever owns the real tool registry. */
    public interface ToolRunner {
        ToolResult run(ToolCall call) throws Exception;
    }

    /**
     * Judges the OBJECTIVE, not the plan.
     *
     * Returning satisfied stops the task; returning missing evidence keeps it
     * going and says what is still absent. Returning satisfied while the
     * required output is missing is the "claimed done but was not" failure, so
     * implementers should key off real evidence rather than step counts.
     */
    public interface GoalEvaluator {
        Verdict evaluate(Evidence evidence);
    }

    /** What the goal check is given. */
    public static final class Evidence {
        public final String goal;
        public final Map<String, String> results;      // stepId -> output, completed steps
        public final List<String> failures;            // what already went wrong
        public final List<String> artifacts;           // paths produced so far
        public final int toolCalls;
        public final int wavesRun;

        Evidence(String goal, Map<String, String> results, List<String> failures,
                 List<String> artifacts, int toolCalls, int wavesRun) {
            this.goal = goal;
            this.results = Collections.unmodifiableMap(new LinkedHashMap<>(results));
            this.failures = Collections.unmodifiableList(new ArrayList<>(failures));
            this.artifacts = Collections.unmodifiableList(new ArrayList<>(artifacts));
            this.toolCalls = toolCalls;
            this.wavesRun = wavesRun;
        }

        /** Every completed step's output concatenated, for text checks. */
        public String allOutput() {
            StringBuilder sb = new StringBuilder();
            for (String s : results.values()) sb.append(s).append('\n');
            return sb.toString();
        }
    }

    /** The goal check's answer. */
    public static final class Verdict {
        public final boolean satisfied;
        public final String summary;
        public final List<String> missing;

        private Verdict(boolean s, String summary, List<String> missing) {
            this.satisfied = s;
            this.summary = summary == null ? "" : summary;
            this.missing = missing == null ? new ArrayList<String>() : new ArrayList<>(missing);
        }

        public static Verdict met(String summary) { return new Verdict(true, summary, null); }
        public static Verdict notYet(String... missing) {
            List<String> m = new ArrayList<>();
            if (missing != null) for (String s : missing) if (s != null && !s.trim().isEmpty()) m.add(s.trim());
            return new Verdict(false, "", m);
        }
    }

    /**
     * Offers a replacement plan when results invalidate the assumptions the
     * plan was built on. Returning null or empty means "keep the current plan".
     */
    public interface Replanner {
        List<TaskGraph.Spec> replan(Evidence evidence);
    }

    /** Receives progress as it happens. Must tolerate calls from worker threads. */
    public interface ProgressSink {
        void onProgress(Progress p);
    }

    // ============================================================== events

    public static final class Progress {
        public static final String PLANNED = "planned";
        public static final String WAVE_STARTED = "wave_started";
        public static final String STEP_STARTED = "step_started";
        public static final String STEP_DONE = "step_done";
        public static final String STEP_FAILED = "step_failed";
        public static final String STEP_RETRIED = "step_retried";
        public static final String STEPS_SKIPPED = "steps_skipped";
        public static final String GOAL_CHECK = "goal_check";
        public static final String REPLANNED = "replanned";
        public static final String BUDGET = "budget";
        public static final String FINISHED = "finished";

        public final String type;
        public final String stepId;
        public final String tool;
        public final String detail;
        public final int wave;
        public final int waveSize;
        public final boolean parallel;
        public final double progress;
        public final long elapsedMs;
        public final long at;

        Progress(String type, String stepId, String tool, String detail, int wave, int waveSize,
                 boolean parallel, double progress, long elapsedMs, long at) {
            this.type = type; this.stepId = stepId; this.tool = tool; this.detail = detail;
            this.wave = wave; this.waveSize = waveSize; this.parallel = parallel;
            this.progress = progress; this.elapsedMs = elapsedMs; this.at = at;
        }

        /** One line, for logs and for the UI's operational strip. */
        public String line() {
            StringBuilder sb = new StringBuilder();
            sb.append('[').append(elapsedMs / 1000).append("s] ").append(type);
            if (!stepId.isEmpty()) sb.append(' ').append(stepId);
            if (!tool.isEmpty()) sb.append(" via ").append(tool);
            if (STEP_STARTED.equals(type) || STEP_DONE.equals(type)) {
                sb.append(" (wave ").append(wave + 1);
                /* Describe how THIS step was dispatched, not how big its wave
                   was: a wave of three stateful steps runs one at a time, and
                   labelling that "3 in parallel" would misreport the run. */
                sb.append(parallel ? ", parallel" : ", serial");
                if (waveSize > 1) sb.append(", ").append(waveSize).append(" in wave");
                sb.append(')');
            }
            if (!detail.isEmpty()) sb.append(" -- ").append(detail);
            return sb.toString();
        }
    }

    // =============================================================== budget

    /**
     * Every limit the executor honours, in one place and printable.
     *
     * These are not hidden constants: {@link #describe} renders them so the
     * runtime and the UI can show what a task is allowed to spend before it is
     * stopped, and a caller can raise or lower them per task.
     */
    public static final class Budget {
        public int maxStepAttempts = 3;
        /** Hard ceiling on tool calls for the whole task. The anti-runaway limit. */
        public int maxToolCalls = 12;
        /** Hard ceiling on dependency waves. */
        public int maxWaves = 8;
        /** How many independent steps may overlap. */
        public int maxParallel = 3;
        /** Wall clock for the whole task. 0 means no time limit. */
        public long taskDeadlineMs = 0;
        /** Wall clock for one tool call. 0 means no per-call limit. */
        public long stepTimeoutMs = 0;
        /** How many times a plan may be replaced. Bounds re-planning loops. */
        public int maxReplans = 2;

        public static Budget standard() { return new Budget(); }

        public Budget withMaxStepAttempts(int n) { this.maxStepAttempts = Math.max(1, n); return this; }
        public Budget withMaxToolCalls(int n) { this.maxToolCalls = Math.max(1, n); return this; }
        public Budget withMaxWaves(int n) { this.maxWaves = Math.max(1, n); return this; }
        public Budget withMaxParallel(int n) { this.maxParallel = Math.max(1, n); return this; }
        public Budget withStepTimeoutMs(long ms) { this.stepTimeoutMs = Math.max(0, ms); return this; }
        public Budget withTaskDeadlineMs(long ms) { this.taskDeadlineMs = Math.max(0, ms); return this; }

        /** Rendered so the runtime can state its limits instead of hiding them. */
        public String describe() {
            return "budget: <= " + maxToolCalls + " tool calls, <= " + maxWaves + " waves, "
                    + maxStepAttempts + " attempt(s)/step, <= " + maxParallel + " in parallel"
                    + (stepTimeoutMs > 0 ? ", " + (stepTimeoutMs / 1000) + "s/step" : "")
                    + (taskDeadlineMs > 0 ? ", " + (taskDeadlineMs / 1000) + "s task" : "")
                    + ", <= " + maxReplans + " replan(s)";
        }

        public JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("maxStepAttempts", maxStepAttempts);
            o.put("maxToolCalls", maxToolCalls);
            o.put("maxWaves", maxWaves);
            o.put("maxParallel", maxParallel);
            o.put("taskDeadlineMs", taskDeadlineMs);
            o.put("stepTimeoutMs", stepTimeoutMs);
            o.put("maxReplans", maxReplans);
            return o;
        }

        static Budget fromJson(JSONObject o) throws JSONException {
            Budget b = new Budget();
            if (o == null) return b;
            b.maxStepAttempts = o.optInt("maxStepAttempts", b.maxStepAttempts);
            b.maxToolCalls = o.optInt("maxToolCalls", b.maxToolCalls);
            b.maxWaves = o.optInt("maxWaves", b.maxWaves);
            b.maxParallel = o.optInt("maxParallel", b.maxParallel);
            b.taskDeadlineMs = o.optLong("taskDeadlineMs", b.taskDeadlineMs);
            b.stepTimeoutMs = o.optLong("stepTimeoutMs", b.stepTimeoutMs);
            b.maxReplans = o.optInt("maxReplans", b.maxReplans);
            return b;
        }
    }

    // =============================================================== result

    /** One step's execution, with the timestamps that prove concurrency. */
    public static final class StepRun {
        public final String stepId;
        public final String tool;
        public final int wave;
        public final boolean parallel;
        public int attempts;
        public long startedAt;
        public long endedAt;
        public boolean ok;
        public String detail = "";

        StepRun(String stepId, String tool, int wave, boolean parallel) {
            this.stepId = stepId; this.tool = tool; this.wave = wave; this.parallel = parallel;
        }

        public long durationMs() { return startedAt == 0 ? 0 : (endedAt == 0 ? System.currentTimeMillis() : endedAt) - startedAt; }
    }

    public static final class Outcome {
        public static final String COMPLETED = "completed";
        public static final String FAILED = "failed";
        public static final String CANCELLED = "cancelled";
        public static final String DEADLOCK = "deadlock";
        public static final String BUDGET = "budget_exhausted";
        public static final String TIMEOUT = "timed_out";

        public final String status;
        public final String reason;
        public final int wavesRun;
        public final int toolCalls;
        public final int peakParallel;
        public final long durationMs;
        public final String goalSummary;

        Outcome(String status, String reason, int wavesRun, int toolCalls, int peakParallel,
                long durationMs, String goalSummary) {
            this.status = status; this.reason = reason == null ? "" : reason;
            this.wavesRun = wavesRun; this.toolCalls = toolCalls; this.peakParallel = peakParallel;
            this.durationMs = durationMs; this.goalSummary = goalSummary == null ? "" : goalSummary;
        }

        public boolean succeeded() { return COMPLETED.equals(status); }
        public boolean terminal() { return true; }   // every status here is terminal

        public String line() {
            return status + " in " + durationMs + "ms -- " + wavesRun + " wave(s), "
                    + toolCalls + " tool call(s), peak parallelism " + peakParallel
                    + (reason.isEmpty() ? "" : " (" + reason + ")");
        }
    }

    // ============================================================== executor

    private final TaskRecord record;
    /** The plan being executed. Not final: a re-plan replaces it. */
    private TaskGraph graph;
    private final Map<String, ToolCall> calls;
    private final ToolRunner runner;
    private final GoalEvaluator goal;
    private final Replanner replanner;
    private final ProgressSink sink;
    private final Budget budget;
    private final boolean[] cancelledFlag;

    private final Map<String, String> stepNames = new LinkedHashMap<>();
    private final Map<String, String> results = new LinkedHashMap<>();
    private final List<String> failures = new ArrayList<>();
    private final List<String> artifacts = new ArrayList<>();
    /**
     * Steps whose last failure looked environmental rather than intrinsic.
     *
     * A tunnel that dropped or an engine that went away says nothing about
     * whether the step itself is possible, so these are the ones a different
     * engine may legitimately retry. A permanent failure is not resumable:
     * resuming one would spend the new engine's budget on the same wall.
     */
    private final java.util.Set<String> resumable =
            java.util.Collections.synchronizedSet(new java.util.LinkedHashSet<String>());
    private final List<StepRun> runs = new ArrayList<>();
    private final List<Progress> history = new ArrayList<>();

    private final AtomicInteger toolCalls = new AtomicInteger();
    private final AtomicInteger peakParallel = new AtomicInteger();
    private final AtomicInteger inFlight = new AtomicInteger();
    private final Object eventLock = new Object();
    /**
     * Guards the graph. Steps run on several threads and every one of them
     * reads node state and writes results back, so unsynchronised access would
     * be a data race on the very structure the schedule depends on.
     */
    private final Object graphLock = new Object();

    private volatile int wavesRun;
    private volatile int replans;
    private volatile long startedAt;
    private long endedAt;

    private TaskGraphExecutor(TaskRecord record, TaskGraph graph, Map<String, ToolCall> calls,
                              ToolRunner runner, GoalEvaluator goal, Replanner replanner,
                              ProgressSink sink, Budget budget, boolean[] cancelledFlag) {
        this.record = record;
        this.graph = graph;
        this.calls = calls;
        this.runner = runner;
        this.goal = goal;
        this.replanner = replanner;
        this.sink = sink;
        this.budget = budget == null ? Budget.standard() : budget;
        this.cancelledFlag = cancelledFlag;
    }

    /**
     * Bind a plan to its tools and run it.
     *
     * @param specs the plan, with dependencies
     * @param calls stepId -> tool invocation; a step with no call is a no-op
     *              that completes immediately
     */
    public static Outcome run(TaskRecord record, List<TaskGraph.Spec> specs,
                              Map<String, ToolCall> calls, ToolRunner runner,
                              GoalEvaluator goal, ProgressSink sink, Budget budget) {
        return run(record, specs, calls, runner, goal, null, sink, budget, null);
    }

    public static Outcome run(TaskRecord record, List<TaskGraph.Spec> specs,
                              Map<String, ToolCall> calls, ToolRunner runner,
                              GoalEvaluator goal, ProgressSink sink, Budget budget,
                              boolean[] cancelledFlag) {
        return run(record, specs, calls, runner, goal, null, sink, budget, cancelledFlag);
    }

    public static Outcome run(TaskRecord record, List<TaskGraph.Spec> specs,
                              Map<String, ToolCall> calls, ToolRunner runner,
                              GoalEvaluator goal, Replanner replanner, ProgressSink sink,
                              Budget budget, boolean[] cancelledFlag) {
        Prepared p = prepare(record, specs, calls, runner, goal, replanner, sink, budget, cancelledFlag);
        if (p.executor == null) return p.rejection;
        return p.executor.execute();
    }

    /** A prepared executor, or the reason it was refused. */
    public static final class Prepared {
        public final TaskGraphExecutor executor;
        public final Outcome rejection;
        Prepared(TaskGraphExecutor e, Outcome r) { this.executor = e; this.rejection = r; }
    }

    /**
     * Build the executor without starting it.
     *
     * A refused plan is returned as a terminal FAILED outcome rather than thrown,
     * so a caller always gets a status it can report instead of an exception to
     * catch -- and an unrunnable plan still has to reach a truthful end state.
     */
    public static Prepared prepare(TaskRecord record, List<TaskGraph.Spec> specs,
                                   Map<String, ToolCall> calls, ToolRunner runner,
                                   GoalEvaluator goal, Replanner replanner, ProgressSink sink,
                                   Budget budget, boolean[] cancelledFlag) {
        if (record == null) throw new IllegalArgumentException("record");
        if (runner == null) throw new IllegalArgumentException("runner");
        if (specs == null || specs.isEmpty()) {
            record.fail("the plan is empty: there is nothing to run");
            return new Prepared(null, new Outcome(Outcome.FAILED, "the plan is empty", 0, 0, 0, 0, ""));
        }
        TaskGraph probe = TaskGraph.build(specs);
        if (!probe.isValid()) {
            record.fail("the plan cannot run: " + probe.buildError());
            return new Prepared(null, new Outcome(Outcome.FAILED, probe.buildError(), 0, 0, 0, 0, ""));
        }
        record.planGraph(specs);
        /* Use the graph the RECORD holds, not the one just validated. Running
           against a second copy would leave the record describing a plan that
           never executed -- which is how a completed task ends up reporting
           every step as pending. */
        TaskGraph g = record.graph;
        return new Prepared(new TaskGraphExecutor(record, g,
                calls == null ? new LinkedHashMap<String, ToolCall>() : calls,
                runner, goal, replanner, sink, budget, cancelledFlag), null);
    }

    // ---------------------------------------------------------------- loop

    private Outcome execute() {
        startedAt = System.currentTimeMillis();
        /* The record's phases have to describe what really happened: a task
           that is running tools is EXECUTING, and it is not COMPLETED until
           the outcome has been checked. */
        record.moveTo(TaskRecord.Phase.EXECUTING);
        seedSteps();
        List<List<String>> schedule = gWaves();
        emit(new Progress(Progress.PLANNED, "", "", describePlan(schedule),
                0, 0, false, 0, 0, System.currentTimeMillis()));

        String status = null, reason = "", goalSummary = "";

        while (true) {
            if (isCancelled()) { status = Outcome.CANCELLED; reason = "cancelled by the user"; break; }
            if (gAllSettled()) {
                status = "completed".equals(gOutcome()) ? Outcome.COMPLETED : Outcome.FAILED;
                reason = status.equals(Outcome.COMPLETED) ? "every step finished" : failedSummary();
                break;
            }
            if (wavesRun >= budget.maxWaves) {
                status = Outcome.BUDGET; reason = "hit the " + budget.maxWaves + "-wave limit"; break;
            }
            if (budget.taskDeadlineMs > 0 && elapsed() >= budget.taskDeadlineMs) {
                status = Outcome.TIMEOUT; reason = "hit the " + (budget.taskDeadlineMs / 1000) + "s task limit"; break;
            }
            if (toolCalls.get() >= budget.maxToolCalls) {
                status = Outcome.BUDGET; reason = "hit the " + budget.maxToolCalls + "-tool-call limit"; break;
            }

            List<TaskGraph.Node> ready = gRunnable();
            if (ready.isEmpty()) {
                if (gDeadlocked()) {
                    status = Outcome.DEADLOCK;
                    reason = "nothing left to run but work remains: " + gUnfinished();
                } else {
                    status = Outcome.FAILED;
                    reason = "no runnable step and no deadlock detected: " + gUnfinished();
                }
                break;
            }

            int wave = waveIndexOf(ready);
            runWave(wave, ready);
            wavesRun++;

            /* The objective decides whether to continue. Checking here, after
               each wave, is what stops an agent from searching for information
               it has already found. */
            Verdict v = checkGoal();
            emit(new Progress(Progress.GOAL_CHECK, "", "",
                    v.satisfied ? "goal satisfied -- " + v.summary
                                : "not yet" + (v.missing.isEmpty() ? "" : ": " + v.missing),
                    wave, ready.size(), false, gProgress(), elapsed(), System.currentTimeMillis()));
            if (v.satisfied) {
                goalSummary = v.summary;
                int skipped = skipRemaining("the goal is already satisfied: " + v.summary);
                if (skipped > 0) {
                    emit(new Progress(Progress.STEPS_SKIPPED, "", "", skipped + " step(s) skipped, goal met",
                            wave, 0, false, gProgress(), elapsed(), System.currentTimeMillis()));
                }
                status = Outcome.COMPLETED;
                reason = "goal satisfied after " + wavesRun + " wave(s)";
                break;
            }

            /* Offered whenever the objective is still unmet, not only after a
               failure: a plan can be invalidated by a result that succeeded.
               Declining is returning null, and maxReplans bounds the total,
               so this cannot become a re-planning loop. */
            if (replans < budget.maxReplans && replanner != null) {
                List<TaskGraph.Spec> next = null;
                try { next = replanner.replan(evidence()); } catch (Exception ignored) { next = null; }
                if (next != null && !next.isEmpty()) {
                    String err = replacePlan(next);
                    if (err == null) {
                        replans++;
                        emit(new Progress(Progress.REPLANNED, "", "", "plan replaced (" + replans + "/" + budget.maxReplans + ")",
                                wave, 0, false, gProgress(), elapsed(), System.currentTimeMillis()));
                    }
                }
            }
        }

        endedAt = System.currentTimeMillis();
        if (!isCancelled() && !record.isTerminal()) record.moveTo(TaskRecord.Phase.VALIDATING);
        closeRecord(status, reason, goalSummary);
        Outcome o = new Outcome(status, reason, wavesRun, toolCalls.get(), peakParallel.get(),
                endedAt - startedAt, goalSummary);
        emit(new Progress(Progress.FINISHED, "", "", o.line(),
                wavesRun, 0, false, gProgress(), o.durationMs, System.currentTimeMillis()));
        return o;
    }

    /** Run one wave: independent steps at once, stateful ones strictly serial. */
    private void runWave(int wave, List<TaskGraph.Node> ready) {
        List<TaskGraph.Node> safe = new ArrayList<>();
        List<TaskGraph.Node> exclusive = new ArrayList<>();
        for (TaskGraph.Node n : ready) {
            ToolCall c = calls.get(n.id);
            if (c != null && c.parallelSafe) safe.add(n); else exclusive.add(n);
        }
        int waveSize = ready.size();
        boolean parallel = safe.size() > 1;
        emit(new Progress(Progress.WAVE_STARTED, "", "",
                waveSize + " step(s)" + (parallel ? ", " + safe.size() + " in parallel" : ", serial"),
                wave, waveSize, parallel, gProgress(), elapsed(), System.currentTimeMillis()));

        /* Parallel-safe first, concurrently. Anything that touches a file, a
           process or shared state waits until those are done and then runs one
           at a time, so the executor can never race a stateful operation. */
        if (safe.size() > 1) runConcurrently(wave, safe, waveSize);
        else if (safe.size() == 1) executeStep(wave, safe.get(0), waveSize, false);

        for (TaskGraph.Node n : exclusive) {
            if (isCancelled()) return;
            executeStep(wave, n, waveSize, false);
        }
    }

    private void runConcurrently(final int wave, List<TaskGraph.Node> nodes, final int waveSize) {
        int threads = Math.max(1, Math.min(budget.maxParallel, nodes.size()));
        ExecutorService pool = Executors.newFixedThreadPool(threads, new ThreadFactory() {
            private final AtomicInteger n = new AtomicInteger();
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "aether-wave-" + n.incrementAndGet());
                t.setDaemon(true);
                return t;
            }
        });
        try {
            List<Future<?>> futures = new ArrayList<>();
            for (final TaskGraph.Node n : nodes) {
                if (toolCalls.get() >= budget.maxToolCalls) break;
                futures.add(pool.submit(new Callable<Void>() {
                    public Void call() { executeStep(wave, n, waveSize, true); return null; }
                }));
            }
            for (Future<?> f : futures) {
                try { f.get(); } catch (Exception e) { /* recorded by the step itself */ }
            }
        } finally {
            pool.shutdown();
            try { pool.awaitTermination(5, TimeUnit.SECONDS); } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /**
     * One step, with retries for transient failures only.
     *
     * Deliberately NOT synchronized on the executor: this method is what runs
     * concurrently, so an instance-level lock here would serialise every wave
     * and quietly cancel the parallelism the whole class exists to provide.
     * Shared state is guarded individually -- {@link TaskRecord}'s own methods
     * are synchronized, and every read or write of the graph takes graphLock.
     */
    private void executeStep(int wave, final TaskGraph.Node node, int waveSize, boolean parallel) {
        synchronized (graphLock) {
            if (isCancelled() || !TaskGraph.PENDING.equals(node.state)) return;
        }

        ToolCall call = calls.get(node.id);
        String stepName = stepNames.get(node.id);

        StepRun run = new StepRun(node.id, call == null ? "" : call.tool, wave, parallel);
        run.startedAt = System.currentTimeMillis();
        synchronized (runs) { runs.add(run); }

        int maxAttempts = Math.min(budget.maxStepAttempts, Math.max(1, record.maxStepAttempts));
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            if (isCancelled()) break;

            /* Claim budget for THIS invocation, retries included. Counting only
               distinct steps would let a flaky tool spend
               maxToolCalls x maxStepAttempts calls while reporting the smaller
               number -- and the smaller number is the one a caller trusts.
               The claim is atomic, so concurrent steps cannot overspend it. */
            boolean noBudget = false;
            if (call != null && toolCalls.incrementAndGet() > budget.maxToolCalls) {
                toolCalls.decrementAndGet();
                noBudget = true;
                /* On the first attempt nothing has been touched yet, so the step
                   is left PENDING and the outer loop reports BUDGET_EXHAUSTED
                   rather than a step that broke. */
                if (attempt == 1) return;
            }

            run.attempts = attempt;
            record.startStep(stepName);
            gMarkRunning(node.id);

            int inNow = inFlight.incrementAndGet();
            peakParallel.accumulateAndGet(inNow, Math::max);
            emit(new Progress(Progress.STEP_STARTED, node.id, run.tool,
                    attempt > 1 ? "attempt " + attempt : "", wave, waveSize, parallel,
                    gProgress(), elapsed(), System.currentTimeMillis()));

            ToolResult r;
            long t0 = System.currentTimeMillis();
            if (noBudget) {
                r = ToolResult.failure("the tool-call budget ran out during retries");
            } else if (call == null) {
                r = ToolResult.of("no tool bound; nothing to do");
            } else {
                try {
                    r = invokeWithTimeout(call);
                } catch (TimeoutException te) {
                    r = ToolResult.retryable("timed out after " + (budget.stepTimeoutMs / 1000) + "s");
                } catch (Exception e) {
                    r = isTransient(e) ? ToolResult.retryable(String.valueOf(e.getMessage()))
                                       : ToolResult.failure(String.valueOf(e.getMessage()));
                }
            }
            r.elapsedMs = System.currentTimeMillis() - t0;
            inFlight.decrementAndGet();

            if (r.ok) {
                String summary = summarise(r.output);
                record.finishStep(stepName, true, summary);
                gMarkDone(node.id, summary);
                run.endedAt = System.currentTimeMillis();
                run.ok = true;
                run.detail = summary;
                synchronized (results) { results.put(node.id, r.output); }
                if (r.hasArtifact()) {
                    record.recordArtifact(r.artifactPath, r.artifactChange, r.artifactBytes);
                    synchronized (artifacts) { artifacts.add(r.artifactPath); }
                }
                record.recordResult(node.id + ": " + summary);
                emit(new Progress(Progress.STEP_DONE, node.id, run.tool,
                        summary + (r.elapsedMs > 0 ? " (" + r.elapsedMs + "ms)" : ""),
                        wave, waveSize, parallel, gProgress(), elapsed(), System.currentTimeMillis()));
                return;
            }

            record.finishStep(stepName, false, r.error);
            boolean outOfAttempts = attempt >= maxAttempts;
            boolean budgetGone = !r.transientFailure && r.error.contains("budget is exhausted");
            if (r.transientFailure && !outOfAttempts) {
                emit(new Progress(Progress.STEP_RETRIED, node.id, run.tool,
                        "retrying after: " + r.error, wave, waveSize, parallel,
                        gProgress(), elapsed(), System.currentTimeMillis()));
                continue;
            }
            /* Permanent, or out of attempts. Fail the step and everything that
               depended on it: a branch whose prerequisite cannot be met is not
               worth spending budget on. */
            gMarkFailed(node.id, r.error);
            if (r.transientFailure) resumable.add(node.id);
            record.recordError(node.id + ": " + r.error);
            synchronized (failures) { failures.add(node.id + ": " + r.error); }
            int skipped = gPropagate(node.id);
            run.endedAt = System.currentTimeMillis();
            run.detail = r.error;
            emit(new Progress(Progress.STEP_FAILED, node.id, run.tool,
                    r.error + (skipped > 0 ? "; " + skipped + " dependent step(s) skipped" : ""),
                    wave, waveSize, parallel, gProgress(), elapsed(), System.currentTimeMillis()));
            if (skipped > 0) {
                for (TaskGraph.Node d : gNodes()) {
                    if (TaskGraph.SKIPPED.equals(d.state) && !d.id.equals(node.id)) {
                        record.finishStep(stepNames.get(d.id), false, "skipped: its prerequisite failed");
                    }
                }
                emit(new Progress(Progress.STEPS_SKIPPED, node.id, "", skipped + " dependent step(s) cannot run",
                        wave, 0, false, gProgress(), elapsed(), System.currentTimeMillis()));
            }
            if (budgetGone) return;
            return;
        }
        /* Fell out of the attempt loop without succeeding or failing, which
           means it was cancelled mid-retry. Leave the node pending; the outer
           loop reports cancellation. */
        run.endedAt = System.currentTimeMillis();
    }

    /** Applies the per-step timeout only when one is configured. */
    private ToolResult invokeWithTimeout(final ToolCall call) throws Exception {
        if (budget.stepTimeoutMs <= 0) return runner.run(call);
        ExecutorService one = Executors.newSingleThreadExecutor(new ThreadFactory() {
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "aether-tool-" + call.stepId);
                t.setDaemon(true);
                return t;
            }
        });
        try {
            Future<ToolResult> f = one.submit(new Callable<ToolResult>() {
                public ToolResult call() throws Exception { return runner.run(call); }
            });
            try {
                return f.get(budget.stepTimeoutMs, TimeUnit.MILLISECONDS);
            } catch (java.util.concurrent.ExecutionException ee) {
                Throwable c = ee.getCause();
                if (c instanceof Exception) throw (Exception) c;
                throw ee;
            }
        } finally {
            one.shutdownNow();
        }
    }

    private static boolean isTransient(Exception e) {
        if (e instanceof TimeoutException) return true;
        String m = String.valueOf(e.getMessage()).toLowerCase();
        /* An explicit HTTP client error is a permanent answer, not a blip: the
           server understood the request and refused it. Retrying a 403 or a 404
           just spends budget on a request that will never succeed. 408 and 429
           are the exceptions, because both are explicitly "try again". */
        if (m.matches("(?s).*http 4\\d\\d.*") && !m.contains("http 408") && !m.contains("http 429")) {
            return false;
        }
        if (e instanceof IOException) return true;
        return m.contains("timeout") || m.contains("timed out") || m.contains("connection")
                || m.contains("temporar") || m.contains("503") || m.contains("524");
    }

    // ---------------------------------------------------------------- goal

    private Verdict checkGoal() {
        if (goal == null) return Verdict.notYet();
        try {
            Verdict v = goal.evaluate(evidence());
            return v == null ? Verdict.notYet() : v;
        } catch (Exception e) {
            /* A broken evaluator must not mark a task complete. Not-yet is the
               only safe answer: it keeps the plan running and leaves the final
               status to the graph. */
            record.recordError("the goal check failed: " + e.getMessage());
            return Verdict.notYet();
        }
    }

    private Evidence evidence() {
        synchronized (results) {
            synchronized (failures) {
                synchronized (artifacts) {
                    return new Evidence(record.goal, results, failures, artifacts,
                            toolCalls.get(), wavesRun);
                }
            }
        }
    }

    /**
     * Mark everything still pending as SKIPPED because the objective is already
     * met.
     *
     * These steps are unnecessary, not broken, so they are recorded as skipped
     * and the graph is told the goal was satisfied. Recording them as failures
     * instead -- or leaving them pending -- would make a task that finished
     * correctly look like one that ran out of road, which is precisely the
     * mislabel the previous implementation produced.
     */
    private int skipRemaining(String why) {
        int n = 0;
        synchronized (graphLock) {
            graph.markGoalSatisfied(why);
            for (TaskGraph.Node node : graph.nodes()) {
                if (!TaskGraph.PENDING.equals(node.state)) continue;
                node.state = TaskGraph.SKIPPED;
                node.result = why;
                record.skipStep(stepNames.get(node.id), why);
                n++;
            }
        }
        return n;
    }

    /** Why a failed run failed, naming the steps rather than saying "a step failed". */
    private String failedSummary() {
        StringBuilder sb = new StringBuilder();
        for (TaskGraph.Node n : gNodes()) {
            if (!TaskGraph.FAILED.equals(n.state)) continue;
            if (sb.length() > 0) sb.append("; ");
            sb.append(n.id).append(n.error.isEmpty() ? "" : " -- " + n.error);
        }
        return sb.length() == 0 ? "a step failed" : sb.toString();
    }

    // ------------------------------------------------- guarded graph access
    /* Every one of these takes graphLock, because steps run on several threads
       and the graph is the structure the schedule is derived from. */

    private void gMarkRunning(String id) { synchronized (graphLock) { graph.markRunning(id); } }
    private void gMarkDone(String id, String result) { synchronized (graphLock) { graph.markDone(id, result); } }
    private void gMarkFailed(String id, String error) { synchronized (graphLock) { graph.markFailed(id, error); } }
    private int gPropagate(String id) { synchronized (graphLock) { return graph.propagateFailure(id); } }
    private double gProgress() { synchronized (graphLock) { return graph.progress(); } }
    private List<TaskGraph.Node> gNodes() { synchronized (graphLock) { return graph.nodes(); } }
    private void gSetAttempts(String id, int n) {
        synchronized (graphLock) { TaskGraph.Node x = graph.get(id); if (x != null) x.attempts = n; }
    }
    private boolean gIsPending(String id) {
        synchronized (graphLock) {
            TaskGraph.Node x = graph.get(id);
            return x != null && TaskGraph.PENDING.equals(x.state);
        }
    }
    private List<TaskGraph.Node> gRunnable() { synchronized (graphLock) { return graph.runnable(); } }
    private boolean gAllSettled() { synchronized (graphLock) { return graph.allSettled(); } }
    private boolean gDeadlocked() { synchronized (graphLock) { return graph.isDeadlocked(); } }
    private List<String> gUnfinished() { synchronized (graphLock) { return graph.unfinished(); } }
    private String gOutcome() { synchronized (graphLock) { return graph.outcome(); } }
    private List<List<String>> gWaves() { synchronized (graphLock) { return graph.waves(); } }

    // --------------------------------------------------------------- plan

    /**
     * Swap in a replacement plan, keeping everything already completed.
     *
     * Re-planning must not restart the task: the results that invalidated the
     * old assumptions are the reason to re-plan, so they have to survive. Steps
     * that already finished stay finished; genuinely new work is appended.
     */
    private String replacePlan(List<TaskGraph.Spec> next) {
        Set<String> done = new LinkedHashSet<>();
        Map<String, String> doneResults = new LinkedHashMap<>();
        for (TaskGraph.Node n : graph.nodes()) {
            if (TaskGraph.DONE.equals(n.state)) { done.add(n.id); doneResults.put(n.id, n.result); }
        }
        TaskGraph g = TaskGraph.build(next);
        if (!g.isValid()) {
            record.recordError("the replacement plan cannot run: " + g.buildError());
            return g.buildError();
        }
        for (String id : done) {
            TaskGraph.Node n = g.get(id);
            if (n != null) g.markDone(id, doneResults.get(id));
        }
        record.graph = g;
        /* The executor has to follow the record onto the new graph, or it
           keeps dispatching the plan that was just invalidated. */
        synchronized (graphLock) { this.graph = g; }
        for (TaskGraph.Node n : g.nodes()) {
            if (!stepNames.containsKey(n.id)) stepNames.put(n.id, uniqueStepName(n));
        }
        for (TaskGraph.Node n : g.nodes()) {
            if (record.indexOf(stepNames.get(n.id)) < 0) record.plan(stepNames.get(n.id));
            if (done.contains(n.id)) record.finishStep(stepNames.get(n.id), true, n.result);
        }
        return null;
    }

    // ------------------------------------------------------------ plumbing

    /**
     * Make sure every node has exactly one step in the record.
     *
     * Idempotent on purpose. A resumed executor has already seeded its steps,
     * and re-deriving the names here produced duplicates under different keys --
     * which left stale pending steps behind, so {@code allStepsSettled()} never
     * became true and a resumed task that had genuinely finished was recorded as
     * a failure.
     */
    private void seedSteps() {
        synchronized (graphLock) {
            for (TaskGraph.Node n : graph.nodes()) {
                if (stepNames.containsKey(n.id)) continue;
                stepNames.put(n.id, uniqueStepName(n));
            }
            for (TaskGraph.Node n : graph.nodes()) {
                String name = stepNames.get(n.id);
                if (record.indexOf(name) < 0) record.plan(name);
            }
        }
    }

    /** Step names double as TaskRecord keys, so they have to be unique. */
    private String uniqueStepName(TaskGraph.Node n) {
        String base = n.title == null || n.title.trim().isEmpty() ? n.id : n.title.trim();
        if (!stepNames.containsValue(base) && !base.equals(n.id)) return base;
        if (!stepNames.containsValue(base)) return base;
        return base + " [" + n.id + "]";
    }

    private int waveIndexOf(List<TaskGraph.Node> ready) {
        Map<String, Integer> of = new LinkedHashMap<>();
        List<List<String>> ws = graph.waves();
        for (int i = 0; i < ws.size(); i++) for (String id : ws.get(i)) of.put(id, i);
        int best = 0;
        for (TaskGraph.Node n : ready) {
            Integer i = of.get(n.id);
            if (i != null) best = Math.max(best, i);
        }
        return best;
    }

    private String describePlan(List<List<String>> schedule) {
        StringBuilder sb = new StringBuilder();
        sb.append(graph.size()).append(" step(s) in ").append(schedule.size()).append(" wave(s): ");
        for (int i = 0; i < schedule.size(); i++) {
            if (i > 0) sb.append(" | ");
            sb.append(schedule.get(i).size() == 1 ? schedule.get(i).get(0) : schedule.get(i));
        }
        sb.append(" -- ").append(budget.describe());
        return sb.toString();
    }

    private static String summarise(String output) {
        if (output == null) return "";
        String s = output.replaceAll("\\s+", " ").trim();
        return s.length() <= 240 ? s : s.substring(0, 237) + "...";
    }

    private boolean isCancelled() {
        return cancelledFlag != null && cancelledFlag.length > 0 && cancelledFlag[0];
    }

    private long elapsed() { return System.currentTimeMillis() - startedAt; }

    /** Close the record so its phase, checks and report are truthful. */
    private void closeRecord(String status, String reason, String goalSummary) {
        record.recordCheck(budget.describe());
        record.recordCheck("waves run: " + wavesRun + ", tool calls: " + toolCalls.get()
                + ", peak parallelism: " + peakParallel.get());
        if (!goalSummary.isEmpty()) record.recordCheck("goal satisfied: " + goalSummary);

        if (Outcome.COMPLETED.equals(status)) {
            /* complete() refuses unless something was validated and every step
               settled, so an unmet goal cannot be laundered into a success. */
            if (!goalSummary.isEmpty() || !record.checks.isEmpty()) record.recordCheck("outcome verified against the request");
            if (!record.complete()) {
                record.fail("the plan finished but the task could not be validated: "
                        + (reason.isEmpty() ? gUnfinished().toString() : reason));
            }
        } else if (Outcome.CANCELLED.equals(status)) {
            record.cancel(reason.isEmpty() ? "cancelled" : reason);
        } else {
            record.fail(status + (reason.isEmpty() ? "" : ": " + reason));
        }
    }

    private void emit(Progress p) {
        synchronized (eventLock) {
            history.add(p);
            if (sink != null) {
                try { sink.onProgress(p); } catch (Exception ignored) { }
            }
        }
    }

    // ------------------------------------------------------------ accessors

    public List<Progress> history() { synchronized (eventLock) { return new ArrayList<>(history); } }
    public List<StepRun> runs() { synchronized (runs) { return new ArrayList<>(runs); } }
    public int toolCalls() { return toolCalls.get(); }
    public int peakParallel() { return peakParallel.get(); }
    public int wavesRun() { return wavesRun; }
    public TaskGraph graph() { return graph; }
    public TaskRecord record() { return record; }
    public Map<String, String> results() { synchronized (results) { return new LinkedHashMap<>(results); } }
    public List<String> artifacts() { synchronized (artifacts) { return new ArrayList<>(artifacts); } }

    /**
     * The widest number of steps that actually overlapped.
     *
     * Computed from the recorded start/end timestamps, not from how many
     * threads were requested. A pool of three that never ran two at once
     * reports one, which is the honest answer.
     */
    public int observedConcurrency() {
        List<StepRun> rs = runs();
        List<long[]> iv = new ArrayList<>();
        for (StepRun r : rs) if (r.startedAt > 0 && r.endedAt > r.startedAt) iv.add(new long[]{r.startedAt, r.endedAt});
        int peak = 0;
        for (int i = 0; i < iv.size(); i++) {
            int overlapping = 0;
            for (int j = 0; j < iv.size(); j++) {
                if (iv.get(j)[0] < iv.get(i)[1] && iv.get(i)[0] < iv.get(j)[1]) overlapping++;
            }
            peak = Math.max(peak, overlapping);
        }
        return peak;
    }

    // ------------------------------------------------------------ checkpoint

    /**
     * Everything another engine needs to continue this task from where it
     * stopped: the plan, what finished and what it returned, the artifacts,
     * what to run next and how much budget is left.
     *
     * No engine state is stored, deliberately -- that is what makes the
     * checkpoint portable. A tunnel URL or a model name would pin the resume to
     * the engine that may well be the reason the task stopped.
     */
    public JSONObject checkpoint() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("version", 1);
        o.put("recordId", record.id);
        o.put("goal", record.goal);
        o.put("graph", graph.toJson());
        o.put("budget", budget.toJson());
        o.put("consumedToolCalls", toolCalls.get());
        o.put("wavesRun", wavesRun);
        o.put("replans", replans);
        JSONArray retry = new JSONArray();
        for (String id : resumable) retry.put(id);
        o.put("resumable", retry);
        /* Reported as the wave the NEXT engine will start on: the steps it will
           retry, plus anything already unblocked. An empty list here would tell
           the resuming engine there is nothing to do, which is the opposite of
           the truth when a failure is about to be reset. */
        JSONArray next = new JSONArray();
        java.util.Set<String> listed = new java.util.LinkedHashSet<>();
        for (String id : resumable) {
            TaskGraph.Node n = graph.get(id);
            if (n == null) continue;
            boolean ready = true;
            for (String d : n.deps) {
                TaskGraph.Node dep = graph.get(d);
                if (dep == null || !(TaskGraph.DONE.equals(dep.state) || resumable.contains(dep))) {
                    ready = false; break;
                }
            }
            if (ready && listed.add(id)) next.put(id);
        }
        for (TaskGraph.Node n : gRunnable()) if (listed.add(n.id)) next.put(n.id);
        o.put("nextWave", next);
        JSONArray res = new JSONArray();
        synchronized (results) {
            for (Map.Entry<String, String> e : results.entrySet()) {
                JSONObject r = new JSONObject();
                r.put("step", e.getKey());
                r.put("output", e.getValue());
                res.put(r);
            }
        }
        o.put("results", res);
        JSONArray art = new JSONArray();
        synchronized (artifacts) { for (String a : artifacts) art.put(a); }
        o.put("artifacts", art);
        JSONArray calls = new JSONArray();
        for (Map.Entry<String, ToolCall> e : this.calls.entrySet()) {
            JSONObject c = new JSONObject();
            c.put("step", e.getKey());
            c.put("tool", e.getValue().tool);
            c.put("args", e.getValue().args);
            c.put("parallelSafe", e.getValue().parallelSafe);
            calls.put(c);
        }
        o.put("calls", calls);
        return o;
    }

    /** The ids of the steps another engine should pick up first. */
    public List<String> nextRunnable() {
        List<String> out = new ArrayList<>();
        for (TaskGraph.Node n : graph.runnable()) out.add(n.id);
        return out;
    }

    /**
     * Rebuild an executor from a checkpoint, on any engine.
     *
     * The completed steps come back as completed, so the resumed run does not
     * repeat work the previous engine already did -- which is the whole point of
     * a checkpoint, and the difference between failing over and restarting.
     */
    public static TaskGraphExecutor resume(JSONObject cp, ToolRunner runner, GoalEvaluator goal,
                                           ProgressSink sink, boolean[] cancelledFlag) throws JSONException {
        TaskGraph g = TaskGraph.fromJson(cp.getJSONObject("graph"));
        if (!g.isValid()) throw new JSONException("the checkpoint's plan is not runnable: " + g.buildError());

        JSONArray specsArr = cp.getJSONObject("graph").optJSONArray("nodes");
        List<TaskGraph.Spec> specs = new ArrayList<>();
        if (specsArr != null) {
            for (int i = 0; i < specsArr.length(); i++) {
                JSONObject n = specsArr.getJSONObject(i);
                JSONArray d = n.optJSONArray("deps");
                List<String> deps = new ArrayList<>();
                if (d != null) for (int j = 0; j < d.length(); j++) deps.add(d.getString(j));
                specs.add(new TaskGraph.Spec(n.getString("id"), n.optString("title", n.getString("id")),
                        deps.toArray(new String[0])));
            }
        }
        TaskRecord rec = new TaskRecord(cp.optString("recordId", "resumed"), cp.optString("goal", ""));
        rec.planGraph(specs);
        rec.graph = g;

        Map<String, ToolCall> calls = new LinkedHashMap<>();
        JSONArray cs = cp.optJSONArray("calls");
        if (cs != null) {
            for (int i = 0; i < cs.length(); i++) {
                JSONObject c = cs.getJSONObject(i);
                calls.put(c.getString("step"), new ToolCall(c.getString("step"),
                        c.optString("tool", ""), c.optString("args", ""), c.optBoolean("parallelSafe", false)));
            }
        }
        Budget b = Budget.fromJson(cp.optJSONObject("budget"));

        TaskGraphExecutor ex = new TaskGraphExecutor(rec, g, calls, runner, goal, null, sink, b, cancelledFlag);
        ex.wavesRun = cp.optInt("wavesRun", 0);
        ex.replans = cp.optInt("replans", 0);
        ex.toolCalls.set(cp.optInt("consumedToolCalls", 0));
        ex.startedAt = System.currentTimeMillis();
        JSONArray res = cp.optJSONArray("results");
        if (res != null) {
            for (int i = 0; i < res.length(); i++) {
                JSONObject r = res.getJSONObject(i);
                ex.results.put(r.getString("step"), r.optString("output", ""));
            }
        }
        JSONArray art = cp.optJSONArray("artifacts");
        if (art != null) for (int i = 0; i < art.length(); i++) ex.artifacts.add(art.getString(i));
        /* Steps the previous engine could not finish for environmental reasons
           go back to pending. That is what makes this a failover rather than a
           restart: what succeeded stays done, and only the work the dead engine
           could not finish is attempted again. */
        JSONArray retry = cp.optJSONArray("resumable");
        if (retry != null) {
            java.util.Set<String> reset = new java.util.LinkedHashSet<>();
            for (int i = 0; i < retry.length(); i++) {
                TaskGraph.Node n = g.get(retry.getString(i));
                if (n != null && TaskGraph.FAILED.equals(n.state)) reset.add(n.id);
            }
            /* Work skipped only because a dead engine could not finish its
               prerequisite has to come back too, or the resumed task would
               complete without ever producing the thing the task was for. */
            boolean grew = true;
            while (grew) {
                grew = false;
                for (TaskGraph.Node n : g.nodes()) {
                    if (!TaskGraph.SKIPPED.equals(n.state) || reset.contains(n.id)) continue;
                    for (String d : n.deps) {
                        if (reset.contains(d)) { reset.add(n.id); grew = true; break; }
                    }
                }
            }
            for (String id : reset) {
                TaskGraph.Node n = g.get(id);
                n.attempts = 0;
                n.result = "";
                g.markPending(id);
            }
        }

        /* Steps the previous engine finished must not be re-run. */
        for (TaskGraph.Node n : g.nodes()) {
            final TaskGraph.Node node = n;
            String name = ex.stepNames.computeIfAbsent(node.id, k ->
                    node.title == null || node.title.trim().isEmpty() ? node.id : node.title.trim());
            if (ex.record.indexOf(name) < 0) ex.record.plan(name);
            if (TaskGraph.DONE.equals(node.state)) ex.record.finishStep(name, true, node.result);
            else if (TaskGraph.SKIPPED.equals(node.state)) ex.record.skipStep(name, node.result);
            else if (TaskGraph.FAILED.equals(node.state)) {
                ex.record.finishStep(name, false, node.error);
                ex.record.recordError(node.id + ": " + node.error);
                synchronized (ex.failures) { ex.failures.add(node.id + ": " + node.error); }
            }
        }
        return ex;
    }

    /** Continue a resumed task to a terminal state. */
    public Outcome continueExecution() { return execute(); }
}
