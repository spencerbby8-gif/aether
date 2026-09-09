package com.aether.app.core;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * The dependency graph under a task's plan.
 *
 * WHY THIS EXISTS. A plan used to be a flat list of steps executed in the order
 * they were written. That is wrong in both directions: it serialises work that
 * has nothing to do with each other (search three sources one after another
 * when they could go at once), and it cannot express that one step genuinely
 * needs another's output -- so "install dependencies" and "run the build" were
 * only ordered by luck of the plan's wording.
 *
 * This makes the ordering explicit and derives the schedule from it. Two things
 * fall out that a flat list cannot give you:
 *
 *   - which steps may run together, because everything they depend on is done
 *   - deadlock, detected as "nothing is runnable but work remains" -- which is
 *     otherwise indistinguishable from a task that is merely slow, and is how an
 *     agent ends up waiting for a step that will never become eligible
 *
 * Deterministic and side-effect free: no engine, no clock, no I/O. Every rule
 * here is asserted in TaskGraphProof.
 */
public final class TaskGraph {

    public static final String PENDING = "pending";
    public static final String RUNNING = "running";
    public static final String DONE = "done";
    public static final String FAILED = "failed";
    public static final String SKIPPED = "skipped";

    /** One planned unit of work and what it waits for. */
    public static final class Node {
        public final String id;
        public final String title;
        public final Set<String> deps;
        public String state = PENDING;
        public int attempts;
        public String result = "";
        public String error = "";

        Node(String id, String title, Set<String> deps) {
            this.id = id;
            this.title = title == null ? id : title;
            this.deps = deps;
        }

        public boolean settled() {
            return DONE.equals(state) || FAILED.equals(state) || SKIPPED.equals(state);
        }

        public boolean blockedByFailure() {
            return SKIPPED.equals(state);
        }
    }

    /** How the plan was described before it became a graph. */
    public static final class Spec {
        public final String id;
        public final String title;
        public final List<String> deps;

        public Spec(String id, String title, String... deps) {
            this.id = id;
            this.title = title;
            this.deps = new ArrayList<>();
            if (deps != null) for (String d : deps) if (d != null && !d.isEmpty()) this.deps.add(d);
        }
    }

    private final Map<String, Node> nodes = new LinkedHashMap<>();
    /** Set when the plan cannot be scheduled at all; explains itself. */
    private String buildError;

    private TaskGraph() { }

    /**
     * Build a graph, refusing plans that cannot be executed.
     *
     * A bad plan is reported here rather than discovered halfway through a task:
     * a step waiting on an id that does not exist would otherwise sit pending
     * forever and look like a hang.
     */
    public static TaskGraph build(List<Spec> specs) {
        TaskGraph g = new TaskGraph();
        if (specs == null || specs.isEmpty()) {
            g.buildError = "the plan is empty";
            return g;
        }
        for (Spec s : specs) {
            if (s.id == null || s.id.trim().isEmpty()) {
                g.buildError = "a step has no id";
                return g;
            }
            if (g.nodes.containsKey(s.id)) {
                g.buildError = "step id \"" + s.id + "\" appears twice";
                return g;
            }
            g.nodes.put(s.id, new Node(s.id, s.title, new LinkedHashSet<>(s.deps)));
        }
        /* Dependencies must name real steps. Checked after all ids are known so
           a forward reference is fine. */
        for (Node n : g.nodes.values()) {
            for (String d : n.deps) {
                if (!g.nodes.containsKey(d)) {
                    g.buildError = "step \"" + n.id + "\" waits on \"" + d
                            + "\", which is not in the plan";
                    return g;
                }
                if (d.equals(n.id)) {
                    g.buildError = "step \"" + n.id + "\" waits on itself";
                    return g;
                }
            }
        }
        List<String> cyc = g.cycle();
        if (!cyc.isEmpty()) {
            g.buildError = "the plan is circular: " + String.join(" -> ", cyc);
        }
        return g;
    }

    public boolean isValid() { return buildError == null; }

    public String buildError() { return buildError; }

    public Node get(String id) { return nodes.get(id); }

    public List<Node> nodes() { return new ArrayList<>(nodes.values()); }

    public int size() { return nodes.size(); }

    /**
     * Steps eligible to start right now: not yet settled, not already running,
     * and every dependency DONE.
     *
     * A dependency that FAILED or was SKIPPED does not make a step runnable --
     * it makes it impossible, which {@link #propagateFailure} turns into a skip.
     */
    public List<Node> runnable() {
        List<Node> out = new ArrayList<>();
        if (buildError != null) return out;
        for (Node n : nodes.values()) {
            if (!PENDING.equals(n.state)) continue;
            boolean ready = true;
            for (String d : n.deps) {
                Node dep = nodes.get(d);
                if (dep == null || !DONE.equals(dep.state)) { ready = false; break; }
            }
            if (ready) out.add(n);
        }
        return out;
    }

    /**
     * The plan grouped into waves that may run concurrently.
     *
     * Wave 0 is everything with no dependencies; wave 1 is what those unlock, and
     * so on. This is the shape the executor needs to get parallelism without
     * racing a dependency: everything inside a wave is independent of everything
     * else in it by construction.
     */
    public List<List<String>> waves() {
        List<List<String>> out = new ArrayList<>();
        if (buildError != null) return out;
        /* Computed from the plan's SHAPE, not from what is left to do. An
           earlier version walked only pending steps, so a finished task reported
           "0 waves" and its summary lost the fact that two steps had run in
           parallel. What is runnable right now is runnable()'s job; this is the
           schedule. */
        Map<String, String> state = new LinkedHashMap<>();
        for (Node n : nodes.values()) state.put(n.id, PENDING);

        while (true) {
            List<String> wave = new ArrayList<>();
            for (Node n : nodes.values()) {
                if (!PENDING.equals(state.get(n.id))) continue;
                boolean ready = true;
                for (String d : n.deps) {
                    if (!DONE.equals(state.get(d))) { ready = false; break; }
                }
                if (ready) wave.add(n.id);
            }
            if (wave.isEmpty()) break;
            for (String id : wave) state.put(id, DONE);
            out.add(wave);
            if (out.size() > nodes.size()) break;   // cannot happen; cheap insurance
        }
        return out;
    }

    /**
     * A cycle in the dependency graph, as the chain of ids, or empty.
     *
     * Depth-first with a recursion stack. Iterative would be nicer for very large
     * plans, but plans here are tens of steps and the recursion is bounded by the
     * plan size, which build() has already counted.
     */
    public List<String> cycle() {
        Set<String> done = new LinkedHashSet<>();
        Set<String> stack = new LinkedHashSet<>();
        List<String> path = new ArrayList<>();
        for (String id : nodes.keySet()) {
            List<String> found = visit(id, done, stack, path);
            if (found != null) return found;
        }
        return new ArrayList<>();
    }

    private List<String> visit(String id, Set<String> done, Set<String> stack, List<String> path) {
        if (stack.contains(id)) {
            /* Trim the path down to the cycle itself so the report names the
               loop, not everything walked on the way to it. */
            List<String> cyc = new ArrayList<>();
            int from = path.indexOf(id);
            for (int i = Math.max(from, 0); i < path.size(); i++) cyc.add(path.get(i));
            cyc.add(id);
            return cyc;
        }
        if (done.contains(id)) return null;
        Node n = nodes.get(id);
        if (n == null) return null;
        stack.add(id);
        path.add(id);
        for (String d : n.deps) {
            List<String> found = visit(d, done, stack, path);
            if (found != null) return found;
        }
        path.remove(path.size() - 1);
        stack.remove(id);
        done.add(id);
        return null;
    }

    public void markRunning(String id) {
        Node n = nodes.get(id);
        if (n == null) return;
        n.state = RUNNING;
        n.attempts++;
    }

    public void markDone(String id, String result) {
        Node n = nodes.get(id);
        if (n == null) return;
        n.state = DONE;
        n.result = result == null ? "" : result;
        n.error = "";
    }

    public void markFailed(String id, String error) {
        Node n = nodes.get(id);
        if (n == null) return;
        n.state = FAILED;
        n.error = error == null ? "" : error;
    }

    public void markPending(String id) {
        Node n = nodes.get(id);
        if (n == null) return;
        n.state = PENDING;
        n.error = "";
    }

    /**
     * Skip everything downstream of a step that will not succeed.
     *
     * Without this, a failed step leaves its dependents pending and unrunnable
     * forever -- the graph reports a deadlock that was really just a consequence
     * nobody propagated. Cancellation travels the same way: stopping one step
     * stops the work that needed it.
     *
     * @return how many steps were skipped
     */
    public int propagateFailure(String id) {
        int skipped = 0;
        boolean changed = true;
        while (changed) {
            changed = false;
            for (Node n : nodes.values()) {
                if (!PENDING.equals(n.state) && !RUNNING.equals(n.state)) continue;
                for (String d : n.deps) {
                    Node dep = nodes.get(d);
                    if (dep != null && (FAILED.equals(dep.state) || SKIPPED.equals(dep.state))) {
                        n.state = SKIPPED;
                        n.error = "not attempted: \"" + d + "\" did not succeed";
                        skipped++;
                        changed = true;
                        break;
                    }
                }
            }
        }
        return skipped;
    }

    /** True when every step has reached a final state. */
    public boolean allSettled() {
        for (Node n : nodes.values()) if (!n.settled()) return false;
        return !nodes.isEmpty();
    }

    /**
     * Deadlock: work remains but nothing can start.
     *
     * Distinct from "still running" -- a running step is progress, a deadlock is
     * a plan that will never move again. With propagateFailure in place the only
     * way to reach this is a cycle that slipped past build(), so it is a
     * programming error rather than a runtime condition, and it is reported
     * rather than waited on.
     */
    public boolean isDeadlocked() {
        if (buildError != null) return false;
        if (allSettled()) return false;
        for (Node n : nodes.values()) if (RUNNING.equals(n.state)) return false;
        return runnable().isEmpty();
    }

    /**
     * How the graph ended, or null while it is still in flight.
     *
     * Every path reaches a terminal word: there is no way to finish with work
     * outstanding and no verdict, which is the failure the user actually sees as
     * an agent that quietly stopped.
     */
    public String outcome() {
        if (buildError != null) return "invalid";
        if (!allSettled()) return null;
        boolean anyFailed = false, anySkipped = false, anyDone = false;
        for (Node n : nodes.values()) {
            if (FAILED.equals(n.state)) anyFailed = true;
            else if (SKIPPED.equals(n.state)) anySkipped = true;
            else anyDone = true;
        }
        if (anyFailed) return anyDone ? "failed" : "failed";
        if (anySkipped) return "cancelled";
        return "completed";
    }

    /** Steps that did not succeed, for the final report. */
    public List<String> unfinished() {
        List<String> out = new ArrayList<>();
        for (Node n : nodes.values()) {
            if (!DONE.equals(n.state)) {
                out.add(n.title + " [" + n.state + "]"
                        + (n.error.isEmpty() ? "" : " -- " + n.error));
            }
        }
        return out;
    }

    /** 0..1, by settled steps. Progress that cannot go backwards. */
    public double progress() {
        if (nodes.isEmpty()) return 0;
        int settled = 0;
        for (Node n : nodes.values()) if (n.settled()) settled++;
        return (double) settled / nodes.size();
    }

    // ------------------------------------------------------------ persistence

    public JSONObject toJson() throws JSONException {
        JSONObject o = new JSONObject();
        if (buildError != null) o.put("buildError", buildError);
        JSONArray a = new JSONArray();
        for (Node n : nodes.values()) {
            JSONObject no = new JSONObject();
            no.put("id", n.id);
            no.put("title", n.title);
            no.put("state", n.state);
            no.put("attempts", n.attempts);
            if (!n.result.isEmpty()) no.put("result", n.result);
            if (!n.error.isEmpty()) no.put("error", n.error);
            JSONArray d = new JSONArray();
            for (String dep : n.deps) d.put(dep);
            no.put("deps", d);
            a.put(no);
        }
        o.put("nodes", a);
        return o;
    }

    public static TaskGraph fromJson(JSONObject o) throws JSONException {
        List<Spec> specs = new ArrayList<>();
        JSONArray a = o.optJSONArray("nodes");
        if (a != null) {
            for (int i = 0; i < a.length(); i++) {
                JSONObject no = a.optJSONObject(i);
                if (no == null) continue;
                JSONArray d = no.optJSONArray("deps");
                List<String> deps = new ArrayList<>();
                if (d != null) for (int j = 0; j < d.length(); j++) deps.add(d.optString(j, ""));
                specs.add(new Spec(no.optString("id", ""), no.optString("title", ""),
                        deps.toArray(new String[0])));
            }
        }
        TaskGraph g = build(specs);
        /* States come back after construction: build() validates the shape, the
           recorded states are then restored over the fresh pending ones. */
        if (a != null) {
            for (int i = 0; i < a.length(); i++) {
                JSONObject no = a.optJSONObject(i);
                if (no == null) continue;
                Node n = g.nodes.get(no.optString("id", ""));
                if (n == null) continue;
                n.state = no.optString("state", PENDING);
                n.attempts = no.optInt("attempts", 0);
                n.result = no.optString("result", "");
                n.error = no.optString("error", "");
            }
        }
        if (o.has("buildError") && !o.isNull("buildError")) {
            g.buildError = o.optString("buildError");
        }
        return g;
    }

    /** One-line rendering, for logs and telemetry only -- never shown raw. */
    @Override public String toString() {
        StringBuilder sb = new StringBuilder("TaskGraph[");
        for (Node n : nodes.values()) {
            sb.append(n.id).append(':').append(n.state.toLowerCase(Locale.ROOT)).append(' ');
        }
        return sb.toString().trim() + "]";
    }
}
