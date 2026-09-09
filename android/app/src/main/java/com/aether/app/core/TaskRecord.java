package com.aether.app.core;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * One task's lifecycle, from plan to a terminal state.
 *
 * WHY THIS EXISTS. The agent could stop mid-task: after a tool call, or while
 * still "thinking", leaving the user with no answer and no way to tell whether
 * the work was done, half done, or abandoned. Nothing recorded what had been
 * attempted, so a retry started from scratch and a failed engine lost the work
 * entirely.
 *
 * A task therefore has exactly one of six phases:
 *
 *   PLANNING -> EXECUTING -> VALIDATING -> COMPLETED | FAILED | CANCELLED
 *
 * The last three are TERMINAL. {@link #isTerminal()} is the test the UI and the
 * handoff both use, and the rule that matters is this: a task is never allowed
 * to be reported as finished without having been validated, and it is never
 * allowed to sit in a non-terminal phase and be described as done. If the
 * caller forgets to close a task, {@link #finalReport()} says so in plain words
 * rather than implying success -- an unfinished task that claims completion is
 * the exact failure this class exists to prevent.
 *
 * Kept in the pure-Java layer, not the Activity, so TaskRecordProof can drive
 * every transition. Lifecycle logic that cannot be tested is lifecycle logic
 * that silently rots.
 */
public final class TaskRecord {

    public enum Phase {
        PLANNING, EXECUTING, VALIDATING, COMPLETED, FAILED, CANCELLED;

        public boolean terminal() {
            return this == COMPLETED || this == FAILED || this == CANCELLED;
        }

        /** Whether moving to {@code next} is a legal transition. */
        public boolean canMoveTo(Phase next) {
            if (next == null || this.terminal()) return false;   // terminal is final
            switch (this) {
                case PLANNING:
                    return next == EXECUTING || next == CANCELLED || next == FAILED;
                case EXECUTING:
                    return next == VALIDATING || next == FAILED || next == CANCELLED
                            || next == EXECUTING;                // retries stay here
                case VALIDATING:
                    // Validation may send the task back to work: a retry is a
                    // normal outcome, not an error.
                    return next == COMPLETED || next == FAILED || next == CANCELLED
                            || next == EXECUTING;
                default:
                    return false;
            }
        }
    }

    /** One unit of work inside the task. */
    public static final class Step {
        public static final String PENDING = "pending";
        public static final String RUNNING = "running";
        public static final String DONE = "done";
        public static final String FAILED = "failed";
        public static final String SKIPPED = "skipped";

        public final String name;
        public String status = PENDING;
        public String detail = "";
        public int attempts;
        public long startedAt;
        public long endedAt;

        Step(String name) { this.name = name == null ? "" : name.trim(); }

        public boolean settled() {
            return DONE.equals(status) || FAILED.equals(status) || SKIPPED.equals(status);
        }

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("name", name);
            o.put("status", status);
            o.put("detail", detail);
            o.put("attempts", attempts);
            o.put("startedAt", startedAt);
            o.put("endedAt", endedAt);
            return o;
        }

        static Step fromJson(JSONObject o) throws JSONException {
            Step s = new Step(o.optString("name"));
            s.status = o.optString("status", PENDING);
            s.detail = o.optString("detail", "");
            s.attempts = o.optInt("attempts", 0);
            s.startedAt = o.optLong("startedAt", 0);
            s.endedAt = o.optLong("endedAt", 0);
            return s;
        }
    }

    /** A file the task created or changed. */
    public static final class Artifact {
        public final String path;
        public final String change;     // created | changed | read
        public final long bytes;

        public Artifact(String path, String change, long bytes) {
            this.path = path == null ? "" : path.trim();
            this.change = change == null || change.isEmpty() ? "changed" : change.trim();
            this.bytes = bytes;
        }

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("path", path);
            o.put("change", change);
            o.put("bytes", bytes);
            return o;
        }

        static Artifact fromJson(JSONObject o) {
            return new Artifact(o.optString("path"), o.optString("change"), o.optLong("bytes", 0));
        }
    }

    /** A command the task ran, with what it actually returned. */
    public static final class Command {
        public final String command;
        public final int exitCode;
        public final String outputTail;

        public Command(String command, int exitCode, String outputTail) {
            this.command = command == null ? "" : command.trim();
            this.exitCode = exitCode;
            this.outputTail = outputTail == null ? "" : outputTail;
        }

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("command", command);
            o.put("exitCode", exitCode);
            o.put("outputTail", outputTail);
            return o;
        }

        static Command fromJson(JSONObject o) {
            return new Command(o.optString("command"), o.optInt("exitCode", 0),
                    o.optString("outputTail", ""));
        }
    }

    public final String id;
    public final String goal;
    public final long createdAt;

    public Phase phase = Phase.PLANNING;
    public long updatedAt;
    /** Engine slot that was working on it, so a handoff knows where it came from. */
    public String engine;

    public final List<Step> steps = new ArrayList<>();
    public final List<Artifact> artifacts = new ArrayList<>();
    public final List<Command> commands = new ArrayList<>();
    public final List<String> results = new ArrayList<>();
    public final List<String> errors = new ArrayList<>();
    public final List<String> remaining = new ArrayList<>();
    /** What validation actually observed. Empty means it was never validated. */
    public final List<String> checks = new ArrayList<>();

    private String closeReason = "";

    public TaskRecord(String id, String goal) {
        this.id = id == null || id.isEmpty() ? ChatStore.newId() : id;
        this.goal = goal == null ? "" : goal.trim();
        this.createdAt = System.currentTimeMillis();
        this.updatedAt = this.createdAt;
    }

    private void touch() { this.updatedAt = System.currentTimeMillis(); }

    // ------------------------------------------------------------- lifecycle

    /**
     * Move to {@code next}. Returns false and changes nothing when the move is
     * illegal, so a caller cannot skip validation and cannot reopen a finished
     * task -- both of which would make the report a lie.
     */
    public synchronized boolean moveTo(Phase next) {
        if (phase == next) { touch(); return true; }
        if (!phase.canMoveTo(next)) return false;
        phase = next;
        touch();
        return true;
    }

    public synchronized void plan(String... names) {
        for (String n : names) {
            if (n != null && !n.trim().isEmpty()) steps.add(new Step(n));
        }
        touch();
    }

    /**
     * How many times one step may be attempted before the task gives up on it.
     *
     * Enforced here, in the primitive, rather than only in {@link #retryStep}.
     * A limit that lives only on the retry path is a limit a caller walks
     * straight past by calling startStep again -- which is exactly how an agent
     * ends up retrying a doomed step for ever. Returns -1 when the step is out
     * of attempts, so the caller has to notice.
     */
    public int maxStepAttempts = 3;

    /**
     * The plan's dependency graph, when the task was decomposed into steps that
     * depend on each other.
     *
     * Null for a simple turn: a question with no sub-steps does not need a
     * schedule, and inventing one would only add a way to be wrong.
     */
    public TaskGraph graph;

    /** Decompose the goal into steps with explicit dependencies. */
    public synchronized boolean planGraph(java.util.List<TaskGraph.Spec> specs) {
        TaskGraph g = TaskGraph.build(specs);
        if (!g.isValid()) {
            recordError("the plan cannot run: " + g.buildError());
            return false;
        }
        graph = g;
        touch();
        return true;
    }

    public synchronized int startStep(String name) {
        int i = indexOf(name);
        if (i < 0) { plan(name); i = steps.size() - 1; }
        Step s = steps.get(i);
        if (s.attempts >= maxStepAttempts) return -1;      // out of attempts
        s.status = Step.RUNNING;
        s.attempts++;
        s.startedAt = System.currentTimeMillis();
        s.endedAt = 0;
        if (phase == Phase.PLANNING) phase = Phase.EXECUTING;
        touch();
        return i;
    }

    public synchronized void finishStep(String name, boolean ok, String detail) {
        int i = indexOf(name);
        if (i < 0) return;
        Step s = steps.get(i);
        s.status = ok ? Step.DONE : Step.FAILED;
        s.detail = detail == null ? "" : detail.trim();
        s.endedAt = System.currentTimeMillis();
        if (phase == Phase.PLANNING) phase = Phase.EXECUTING;
        touch();
    }

    /**
     * Retry a failed step. Recoverable failures are expected; the point of the
     * attempt counter is that a retry is visible instead of silent, and that a
     * caller can give up after N tries instead of looping for ever.
     */
    public synchronized boolean retryStep(String name, int maxAttempts) {
        int i = indexOf(name);
        if (i < 0) return false;
        Step s = steps.get(i);
        if (!Step.FAILED.equals(s.status)) return false;
        if (s.attempts >= maxAttempts) return false;
        startStep(name);
        return true;
    }

    public synchronized void recordArtifact(String path, String change, long bytes) {
        if (path == null || path.trim().isEmpty()) return;
        artifacts.add(new Artifact(path, change, bytes));
        touch();
    }

    public synchronized void recordCommand(String command, int exitCode, String outputTail) {
        commands.add(new Command(command, exitCode, outputTail));
        touch();
    }

    public synchronized void recordResult(String what) {
        if (what != null && !what.trim().isEmpty()) { results.add(what.trim()); touch(); }
    }

    public synchronized void recordError(String what) {
        if (what != null && !what.trim().isEmpty()) { errors.add(what.trim()); touch(); }
    }

    public synchronized void noteRemaining(String what) {
        if (what != null && !what.trim().isEmpty()) { remaining.add(what.trim()); touch(); }
    }

    /** Record what validation observed. This is what makes COMPLETED honest. */
    public synchronized void recordCheck(String what) {
        if (what != null && !what.trim().isEmpty()) { checks.add(what.trim()); touch(); }
    }

    public synchronized int indexOf(String name) {
        if (name == null) return -1;
        String n = name.trim();
        for (int i = 0; i < steps.size(); i++) if (steps.get(i).name.equals(n)) return i;
        return -1;
    }

    public synchronized boolean allStepsSettled() {
        for (Step s : steps) if (!s.settled()) return false;
        return true;
    }

    // -------------------------------------------------------------- closing

    /**
     * Finish the task as COMPLETED.
     *
     * Refuses -- and returns false -- when nothing was validated or a step is
     * still unsettled. Marking an unverified task complete is precisely the
     * "claimed done but was not" failure this class exists to stop, so the
     * caller has to either validate or close it as FAILED.
     */
    public synchronized boolean complete() {
        if (phase.terminal()) return phase == Phase.COMPLETED;
        if (checks.isEmpty()) return false;
        if (!allStepsSettled()) return false;
        for (Step s : steps) if (Step.FAILED.equals(s.status)) return false;
        /* When the goal was decomposed, the decomposition has to have actually
           finished. A tool returning successfully is not the objective being
           met, and a graph with work still pending is the clearest possible
           signal that it was not. */
        if (graph != null) {
            if (graph.isDeadlocked()) {
                recordError("the plan deadlocked: nothing left to run but work remains");
                return false;
            }
            if (!graph.allSettled()) return false;
            if (!"completed".equals(graph.outcome())) return false;
        }
        phase = Phase.COMPLETED;
        touch();
        return true;
    }

    public synchronized boolean fail(String reason) {
        if (phase.terminal()) return phase == Phase.FAILED;
        closeReason = reason == null ? "" : reason.trim();
        if (!closeReason.isEmpty()) recordError(closeReason);
        phase = Phase.FAILED;
        touch();
        return true;
    }

    public synchronized boolean cancel(String reason) {
        if (phase.terminal()) return phase == Phase.CANCELLED;
        closeReason = reason == null ? "" : reason.trim();
        phase = Phase.CANCELLED;
        touch();
        return true;
    }

    public synchronized boolean isTerminal() { return phase.terminal(); }

    public String closeReason() { return closeReason; }

    // --------------------------------------------------------------- report

    /**
     * The final report the user is owed: what was done, what changed, what ran,
     * what came back, what went wrong, what is still open.
     *
     * It never claims more than happened. A task left in a non-terminal phase
     * is reported as unfinished with the reason, not dressed up as a success.
     */
    public synchronized String finalReport() {
        StringBuilder sb = new StringBuilder();
        sb.append("Task: ").append(goal.isEmpty() ? "(no goal recorded)" : goal).append('\n');
        sb.append("State: ").append(phase.name());
        if (!closeReason.isEmpty()) sb.append(" \u2014 ").append(closeReason);
        sb.append('\n');

        if (!phase.terminal()) {
            sb.append("\nNOT FINISHED. The task stopped in ").append(phase.name())
                    .append(" without reaching a terminal state, so nothing here is verified.\n");
        }

        if (!steps.isEmpty()) {
            sb.append("\nSteps\n");
            for (Step s : steps) {
                sb.append("  ").append(s.status).append("  ").append(s.name);
                if (s.attempts > 1) sb.append("  (").append(s.attempts).append(" attempts)");
                if (!s.detail.isEmpty()) sb.append("  \u2014 ").append(s.detail);
                sb.append('\n');
            }
        }

        if (!checks.isEmpty()) {
            sb.append("\nVerified\n");
            for (String c : checks) sb.append("  \u00b7 ").append(c).append('\n');
        }

        if (!artifacts.isEmpty()) {
            sb.append("\nFiles\n");
            for (Artifact a : artifacts) {
                sb.append("  ").append(a.change).append("  ").append(a.path);
                if (a.bytes > 0) sb.append("  (").append(a.bytes).append(" bytes)");
                sb.append('\n');
            }
        }

        if (!commands.isEmpty()) {
            sb.append("\nCommands run\n");
            for (Command c : commands) {
                sb.append("  exit ").append(c.exitCode).append("  ").append(c.command).append('\n');
            }
        }

        if (!results.isEmpty()) {
            sb.append("\nResults\n");
            for (String r : results) sb.append("  \u00b7 ").append(r).append('\n');
        }

        if (!errors.isEmpty()) {
            sb.append("\nErrors\n");
            for (String e : errors) sb.append("  \u00b7 ").append(e).append('\n');
        }

        if (!remaining.isEmpty()) {
            sb.append("\nStill open\n");
            for (String r : remaining) sb.append("  \u00b7 ").append(r).append('\n');
        }

        if (engine != null && !engine.isEmpty()) {
            sb.append("\nEngine: ").append(engine.toUpperCase(Locale.ROOT)).append('\n');
        }
        return sb.toString().trim();
    }

    /**
     * The block handed to another engine so it continues THIS task instead of
     * starting a new one: the goal, what is already done, what is left. Only
     * settled facts go in it -- a new engine must not be told a step succeeded
     * when it did not.
     */
    /** How the decomposed plan went, for the final report. Empty if there was no plan. */
    public synchronized String scheduleSummary() {
        if (graph == null) return "";
        StringBuilder sb = new StringBuilder();
        sb.append("plan: ").append(graph.size()).append(" steps in ")
          .append(graph.waves().size()).append(" wave(s)");
        int parallel = 0;
        for (java.util.List<String> w : graph.waves()) if (w.size() > 1) parallel += w.size();
        if (parallel > 0) sb.append(", ").append(parallel).append(" ran in parallel");
        String out = graph.outcome();
        if (out != null) sb.append(" -> ").append(out);
        java.util.List<String> left = graph.unfinished();
        if (!left.isEmpty()) sb.append("; unfinished: ").append(String.join(", ", left));
        return sb.toString();
    }

    public synchronized String handoff() {
        StringBuilder sb = new StringBuilder();
        sb.append("CONTINUE THIS TASK, do not restart it.\n");
        sb.append("Goal: ").append(goal.isEmpty() ? "(unknown)" : goal).append('\n');
        sb.append("State: ").append(phase.name()).append('\n');
        if (!steps.isEmpty()) {
            sb.append("Already done:\n");
            boolean any = false;
            for (Step s : steps) {
                if (Step.DONE.equals(s.status)) {
                    any = true;
                    sb.append("  - ").append(s.name);
                    if (!s.detail.isEmpty()) sb.append(" (").append(s.detail).append(')');
                    sb.append('\n');
                }
            }
            if (!any) sb.append("  (nothing completed yet)\n");
            sb.append("Not finished:\n");
            boolean left = false;
            for (Step s : steps) {
                if (!Step.DONE.equals(s.status)) {
                    left = true;
                    sb.append("  - ").append(s.name).append(" [").append(s.status).append("]\n");
                }
            }
            if (!left) sb.append("  (all steps completed)\n");
        }
        /* Files and commands belong to the PREVIOUS engine's sandbox. The new
           engine has a fresh environment, so telling it "already done, skip it"
           would leave it referencing files that do not exist. State where they
           are and let it re-create what it still needs. */
        if (!artifacts.isEmpty()) {
            sb.append("Files created on the previous engine (not in your sandbox;")
              .append(" re-create any you need):\n");
            for (Artifact a : artifacts) {
                sb.append("  - ").append(a.path);
                if (!a.change.isEmpty()) sb.append(" (").append(a.change).append(')');
                sb.append('\n');
            }
        }
        if (!commands.isEmpty()) {
            sb.append("Commands the previous engine ran (its environment, not yours):\n");
            for (Command c : commands) {
                sb.append("  - $ ").append(c.command)
                  .append("  [exit ").append(c.exitCode).append("]\n");
            }
        }
        if (!results.isEmpty()) {
            sb.append("Decisions and results so far:\n");
            for (String r : results) sb.append("  - ").append(r).append('\n');
        }
        if (!errors.isEmpty()) {
            sb.append("Failures so far:\n");
            for (String e : errors) sb.append("  - ").append(e).append('\n');
        }
        sb.append("Pick up from the first unfinished step and finish the task.");
        return sb.toString();
    }

    /**
     * What the next engine is actually sent when this task is handed over.
     *
     * Lives here rather than inline in ChatActivity so it can be tested: this is
     * the string that decides whether engine B continues the job or answers the
     * same question a second time, and getting it wrong is invisible until a
     * user complains that the agent restarted.
     *
     * @param prompt  what the user originally asked
     * @param partial text the previous engine had already streamed, if any
     * @param to      the engine taking over, for the record
     */
    public synchronized String continuationPrompt(String prompt, String partial, String to) {
        StringBuilder sb = new StringBuilder();
        sb.append(handoff());
        sb.append("\n\n").append(prompt == null ? "" : prompt);
        int n = partial == null ? 0 : partial.trim().length();
        if (n > 0) {
            sb.append("\n\n[The previous engine stopped mid-answer after ").append(n)
              .append(" characters. Continue from exactly where it stopped. Do not ")
              .append("repeat or restate what is already written below.]\n\n")
              .append(partial.trim());
            recordResult(n + " chars already streamed; continuing on engine "
                    + (to == null ? "?" : to.toUpperCase(java.util.Locale.ROOT)));
        }
        return sb.toString();
    }

    // ------------------------------------------------------------ persistence

    public synchronized JSONObject toJson() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("id", id);
        o.put("goal", goal);
        o.put("phase", phase.name());
        o.put("createdAt", createdAt);
        o.put("updatedAt", updatedAt);
        o.put("closeReason", closeReason);
        o.put("maxStepAttempts", maxStepAttempts);
        if (graph != null) o.put("graph", graph.toJson());
        if (engine != null) o.put("engine", engine);
        JSONArray a = new JSONArray();
        for (Step s : steps) a.put(s.toJson());
        o.put("steps", a);
        JSONArray b = new JSONArray();
        for (Artifact x : artifacts) b.put(x.toJson());
        o.put("artifacts", b);
        JSONArray c = new JSONArray();
        for (Command x : commands) c.put(x.toJson());
        o.put("commands", c);
        o.put("results", new JSONArray(results));
        o.put("errors", new JSONArray(errors));
        o.put("remaining", new JSONArray(remaining));
        o.put("checks", new JSONArray(checks));
        return o;
    }

    public static TaskRecord fromJson(JSONObject o) throws JSONException {
        TaskRecord t = new TaskRecord(o.optString("id"), o.optString("goal"));
        String p = o.optString("phase", Phase.PLANNING.name());
        try {
            t.phase = Phase.valueOf(p);
        } catch (IllegalArgumentException e) {
            t.phase = Phase.PLANNING;
        }
        t.closeReason = o.optString("closeReason", "");
        t.maxStepAttempts = o.optInt("maxStepAttempts", 3);
        JSONObject go = o.optJSONObject("graph");
        if (go != null) t.graph = TaskGraph.fromJson(go);
        t.engine = o.has("engine") && !o.isNull("engine") ? o.optString("engine") : null;
        JSONArray a = o.optJSONArray("steps");
        if (a != null) for (int i = 0; i < a.length(); i++) t.steps.add(Step.fromJson(a.getJSONObject(i)));
        JSONArray b = o.optJSONArray("artifacts");
        if (b != null) for (int i = 0; i < b.length(); i++) t.artifacts.add(Artifact.fromJson(b.getJSONObject(i)));
        JSONArray c = o.optJSONArray("commands");
        if (c != null) for (int i = 0; i < c.length(); i++) t.commands.add(Command.fromJson(c.getJSONObject(i)));
        fill(t.results, o.optJSONArray("results"));
        fill(t.errors, o.optJSONArray("errors"));
        fill(t.remaining, o.optJSONArray("remaining"));
        fill(t.checks, o.optJSONArray("checks"));
        return t;
    }

    private static void fill(List<String> into, JSONArray a) {
        if (a == null) return;
        for (int i = 0; i < a.length(); i++) into.add(a.optString(i, ""));
    }
}
