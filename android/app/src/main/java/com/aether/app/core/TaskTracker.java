package com.aether.app.core;

import java.util.List;

/**
 * Turns a chat turn into a task with a real lifecycle.
 *
 * WHY THIS EXISTS. A turn used to end by drawing whatever arrived. If the engine
 * dropped after two tool calls, the user saw a half answer and nothing recorded
 * that the task was unfinished -- so a retry started from scratch, and a
 * failover to another engine had no idea what had already been done.
 *
 * This is the bridge between what the agent actually did (AgentActivity's
 * measured steps) and the lifecycle the user is owed (TaskRecord's phases and
 * final report). It is deliberately pure and side-effect free: it reads the
 * turn's real signals and writes them into the record, so every rule here can be
 * tested without a device or an engine.
 *
 * The rule that matters most is in {@link #close}: a task is only COMPLETED
 * when something was actually verified, and a turn that failed or was stopped
 * is recorded as FAILED or CANCELLED -- never left hanging in EXECUTING, which
 * is what made the agent look like it had silently stopped at "thinking".
 */
public final class TaskTracker {

    private TaskTracker() { }

    /**
     * The task this prompt belongs to.
     *
     * An unfinished task is CONTINUED, not replaced: "and now deploy it" is the
     * same job as the message before it, and throwing the record away is how
     * work gets repeated. Only a terminal task makes way for a new one.
     */
    public static TaskRecord begin(ChatSession session, String prompt) {
        TaskRecord t = session == null ? null : session.task;
        if (t != null && !t.isTerminal()) return t;
        TaskRecord fresh = new TaskRecord(ChatStore.newId(),
                prompt == null ? "" : prompt.trim());
        if (session != null) {
            session.task = fresh;
            if (session.engine != null) fresh.engine = session.engine;
        }
        return fresh;
    }

    /**
     * Mirror the turn's real activity into the task.
     *
     * Each tool the agent ran becomes a step with the status that was actually
     * measured -- AgentActivity marks a step done when the kernel reports it
     * returned, so this is observation, not inference. A tool that reported
     * nothing is left FAILED rather than quietly called done.
     */
    public static int mirror(TaskRecord t, AgentActivity activity) {
        if (t == null || activity == null) return 0;
        List<AgentActivity.Step> steps = activity.steps();
        int mirrored = 0;
        for (AgentActivity.Step s : steps) {
            String name = s.label == null || s.label.isEmpty() ? s.tool : s.label;
            if (name == null || name.isEmpty()) continue;
            if (t.indexOf(name) < 0) t.plan(name);
            String detail = s.chars > 0 ? (s.chars + " chars") : (s.detail == null ? "" : s.detail);
            if (s.done) {
                t.finishStep(name, s.chars != 0 || detail.isEmpty() == false, AgentActivity.clip(detail, 120));
            } else {
                /* Still open when the turn ended: the engine let go mid-tool.
                   That is a failure of this attempt, not a success. */
                t.startStep(name);
                t.finishStep(name, false, "turn ended while this was running");
            }
            mirrored++;
        }
        if (!t.isTerminal() && t.phase == TaskRecord.Phase.PLANNING && mirrored > 0) {
            t.moveTo(TaskRecord.Phase.EXECUTING);
        }
        return mirrored;
    }

    /**
     * Close the task from the signals the turn really produced.
     *
     * @param ok     the engine reported done:true
     * @param err    the failure reason, or "cancelled" when the user stopped it
     * @param answer the text that actually arrived (may be partial)
     * @param ms     how long the turn took
     * @return the record, now in a terminal phase -- always
     */
    public static TaskRecord close(TaskRecord t, boolean ok, String err,
                                   String answer, long ms) {
        if (t == null) return null;
        if (t.isTerminal()) return t;

        int chars = answer == null ? 0 : answer.trim().length();

        if ("cancelled".equals(err)) {
            if (chars > 0) t.recordResult("partial answer kept (" + chars + " chars)");
            t.noteRemaining("stopped by the user after " + (ms / 1000) + "s");
            t.cancel("stopped by the user after " + (ms / 1000) + "s");
            return t;
        }

        if (!ok) {
            t.recordError(err == null || err.isEmpty() ? "the engine stopped without finishing" : err);
            if (chars > 0) t.noteRemaining("a partial answer arrived (" + chars
                    + " chars) but the turn did not complete");
            t.fail(err == null || err.isEmpty() ? "the engine stopped without finishing" : err);
            return t;
        }

        /* The turn reported success. Verify before claiming it: an empty answer
           with done:true is not a result the user can act on. */
        t.moveTo(TaskRecord.Phase.VALIDATING);
        if (chars == 0) {
            t.recordError("the engine reported done but sent no answer text");
            t.fail("no answer text arrived");
            return t;
        }
        t.recordCheck("answer streamed to completion, " + chars + " chars in "
                + (ms / 1000) + "s");
        if (chars < 20) {
            t.noteRemaining("the answer is very short (" + chars
                    + " chars) -- worth confirming it actually addresses the request");
        }
        if (!t.complete()) {
            /* complete() refuses when a step failed or nothing was verified.
               Report that honestly instead of forcing the phase. */
            t.fail("a step did not succeed");
        }
        return t;
    }
}
