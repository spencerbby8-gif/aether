package com.aether.app.core;

import java.util.ArrayList;
import java.util.List;

/**
 * Groups the engine's real agent steps into ordered phases for display.
 *
 * Two rules keep this honest:
 *
 *   1. Only steps that {@link AgentActivity} produced are grouped. A phase is
 *      never invented to fill space, and an empty run yields an empty list.
 *   2. Grouping is by CONSECUTIVE runs, never by category across the whole
 *      task. If the agent searched, ran a command and searched again, that is
 *      three phases in that order -- the display must not reorder history to
 *      look tidier than it was.
 *
 * Pure Java on purpose: no Android types, so the ordering and duration rules
 * are covered by scripts/proofs/TaskTimelineGroupingProof.java.
 */
public final class AgentRun {

    public enum Kind { REASONING, GATHER, BROWSE, EXECUTE, CREATE, OTHER }

    /** One displayable block: a heading plus the steps that belong to it. */
    public static final class Phase {
        public final Kind kind;
        public final List<AgentActivity.Step> steps = new ArrayList<>();
        /** True when this block has no steps at all (the reasoning block). */
        public final boolean synthetic;
        public boolean running;

        Phase(Kind kind, boolean synthetic) {
            this.kind = kind;
            this.synthetic = synthetic;
        }

        public String title() { return titleFor(kind); }

        public String glyph() { return glyphFor(kind); }

        public int total() { return steps.size(); }

        public int done() {
            int n = 0;
            for (AgentActivity.Step s : steps) if (s.done) n++;
            return n;
        }

        /** Wall time this block spent, from the steps themselves. */
        public long durationMs() {
            long total = 0;
            for (AgentActivity.Step s : steps) total += s.durationMs;
            return total;
        }

        /** "2 of 3" style sub-label; empty for a synthetic block. */
        public String countLabel() {
            if (synthetic) return "";
            int done = done(), total = total();
            return done >= total ? total + (total == 1 ? " step" : " steps")
                    : done + " of " + total;
        }
    }

    private AgentRun() { }

    /**
     * Consecutive same-kind steps become one phase, in the order they happened.
     *
     * @param steps        exactly what the engine reported, never padded
     * @param reasoning    whether the turn reported reasoning, for the lead block
     * @param turnRunning  whether the turn is still in progress
     */
    public static List<Phase> of(List<AgentActivity.Step> steps,
                                 boolean reasoning,
                                 boolean turnRunning) {
        List<Phase> phases = new ArrayList<>();
        if (reasoning) {
            Phase lead = new Phase(Kind.REASONING, true);
            // The reasoning block is "running" only while nothing has been done
            // yet: once a tool starts, the honest active thing is that tool.
            lead.running = turnRunning && (steps == null || steps.isEmpty());
            phases.add(lead);
        }
        if (steps == null) return phases;

        Phase current = null;
        for (AgentActivity.Step step : steps) {
            Kind kind = kindFor(step.tool);
            if (current == null || current.kind != kind) {
                current = new Phase(kind, false);
                phases.add(current);
            }
            current.steps.add(step);
            if (!step.done) current.running = true;
        }
        return phases;
    }

    /**
     * Where a tool belongs. Unknown tools are still shown -- the engine
     * announced them, so hiding them would be the dishonest option -- under
     * "Working" rather than being guessed into a category.
     */
    public static Kind kindFor(String tool) {
        if (tool == null) return Kind.OTHER;
        switch (tool) {
            case "web_search":
            case "fetch_page":
            case "crawl_site":
            case "list_files":
            case "package_files":
                return Kind.GATHER;
            case "browser":
                return Kind.BROWSE;
            case "run_command":
                return Kind.EXECUTE;
            case "generate_image":
            case "generate_voice":
                return Kind.CREATE;
            default:
                return Kind.OTHER;
        }
    }

    public static String titleFor(Kind kind) {
        switch (kind) {
            case REASONING: return "Understanding the task";
            case GATHER:    return "Gathering information";
            case BROWSE:    return "Browsing the web";
            case EXECUTE:   return "Running commands";
            case CREATE:    return "Creating media";
            default:        return "Working";
        }
    }

    public static String glyphFor(Kind kind) {
        switch (kind) {
            case REASONING: return "\u2733";
            case GATHER:    return "\u2315";
            case BROWSE:    return "\u2197";
            case EXECUTE:   return "\u203a";
            case CREATE:    return "\u2726";
            default:        return "\u2022";
        }
    }

    /** Total wall time across every reported step. */
    public static long totalDurationMs(List<Phase> phases) {
        long total = 0;
        for (Phase p : phases) total += p.durationMs();
        return total;
    }

    /** Steps still open anywhere in the run, for the live header. */
    public static int openSteps(List<Phase> phases) {
        int n = 0;
        for (Phase p : phases) n += p.total() - p.done();
        return n;
    }
}
