import com.aether.app.core.TaskRecord;

import org.json.JSONObject;

/**
 * The task lifecycle, driven through every transition.
 *
 * The claims that matter are negative ones: that a task CANNOT be marked
 * complete without validation, CANNOT be reopened once terminal, and CANNOT be
 * reported as finished while it is not. Those are the failures the class exists
 * to prevent, so they are asserted directly rather than trusted.
 *
 * Run: java -cp /tmp/jvm-suite TaskRecordProof
 */
public class TaskRecordProof {
    static int passed = 0, failed = 0;

    static void chk(String what, boolean ok, String seen) {
        System.out.println("  " + (ok ? "ok  " + what : "FAIL " + what) + "   [" + seen + "]");
        if (ok) passed++; else failed++;
    }

    static TaskRecord fresh() {
        TaskRecord t = new TaskRecord("t1", "Build the widget");
        t.plan("fetch data", "transform", "write file");
        return t;
    }

    public static void main(String[] a) throws Exception {
        System.out.println("== the legal path ==");
        TaskRecord t = fresh();
        chk("a new task starts in PLANNING", t.phase == TaskRecord.Phase.PLANNING, t.phase.name());
        chk("planning records the steps", t.steps.size() == 3, t.steps.size() + " steps");
        chk("PLANNING -> EXECUTING is allowed", t.moveTo(TaskRecord.Phase.EXECUTING), t.phase.name());
        chk("EXECUTING -> VALIDATING is allowed", t.moveTo(TaskRecord.Phase.VALIDATING), t.phase.name());
        chk("VALIDATING -> COMPLETED is allowed once work is done",
                t.moveTo(TaskRecord.Phase.COMPLETED), t.phase.name());
        chk("COMPLETED is terminal", t.isTerminal(), t.phase.name());

        System.out.println("\n== terminal is final ==");
        chk("a finished task cannot go back to EXECUTING",
                !t.moveTo(TaskRecord.Phase.EXECUTING), t.phase.name());
        chk("a finished task cannot be re-opened as PLANNING",
                !t.moveTo(TaskRecord.Phase.PLANNING), t.phase.name());
        chk("a finished task cannot be flipped to FAILED",
                !t.moveTo(TaskRecord.Phase.FAILED), t.phase.name());

        System.out.println("\n== illegal jumps are refused ==");
        TaskRecord j = new TaskRecord("t2", "jump");
        chk("PLANNING cannot jump straight to COMPLETED",
                !j.moveTo(TaskRecord.Phase.COMPLETED), j.phase.name());
        chk("PLANNING cannot jump to VALIDATING",
                !j.moveTo(TaskRecord.Phase.VALIDATING), j.phase.name());
        chk("PLANNING -> CANCELLED is allowed", j.moveTo(TaskRecord.Phase.CANCELLED), j.phase.name());

        System.out.println("\n== validation may send the task back to work ==");
        TaskRecord r = new TaskRecord("t3", "retry");
        r.plan("only step");
        r.moveTo(TaskRecord.Phase.EXECUTING);
        r.startStep("only step");
        r.finishStep("only step", false, "network reset");
        r.moveTo(TaskRecord.Phase.VALIDATING);
        chk("VALIDATING -> EXECUTING is allowed for a retry",
                r.moveTo(TaskRecord.Phase.EXECUTING), r.phase.name());
        chk("the failed step can be retried", r.retryStep("only step", 3),
                "attempts=" + r.steps.get(0).attempts);
        r.finishStep("only step", true, "second try worked");
        chk("the retry is recorded as a second attempt", r.steps.get(0).attempts == 2,
                "attempts=" + r.steps.get(0).attempts);
        r.moveTo(TaskRecord.Phase.VALIDATING);
        r.recordCheck("output file exists, 12 bytes");
        chk("the task completes once validated", r.complete(), r.phase.name());

        System.out.println("\n== completion cannot be faked ==");
        TaskRecord u = fresh();
        u.moveTo(TaskRecord.Phase.EXECUTING);
        chk("complete() refuses while steps are unsettled", !u.complete(), u.phase.name());
        u.startStep("fetch data");
        u.finishStep("fetch data", true, "ok");
        u.startStep("transform");
        u.finishStep("transform", true, "ok");
        u.startStep("write file");
        u.finishStep("write file", true, "ok");
        chk("complete() still refuses with nothing validated", !u.complete(), u.phase.name());
        u.recordCheck("file present and parses");
        chk("complete() accepts once something was verified", u.complete(), u.phase.name());

        TaskRecord f = fresh();
        f.moveTo(TaskRecord.Phase.EXECUTING);
        f.startStep("fetch data");
        f.finishStep("fetch data", false, "403");
        f.startStep("transform");
        f.finishStep("transform", true, "ok");
        f.startStep("write file");
        f.finishStep("write file", true, "ok");
        f.recordCheck("looked at the output");
        chk("complete() refuses when a step failed", !f.complete(), f.phase.name());
        chk("a task with a failed step closes as FAILED instead", f.fail("fetch returned 403"),
                f.phase.name());
        chk("the failure reason is recorded as an error",
                f.errors.contains("fetch returned 403"), String.valueOf(f.errors));

        System.out.println("\n== retries give up instead of looping for ever ==");
        TaskRecord g = new TaskRecord("t4", "flaky");
        g.plan("flaky step");
        g.moveTo(TaskRecord.Phase.EXECUTING);
        int started = 0;
        for (int i = 0; i < 10; i++) {
            if (g.startStep("flaky step") < 0) break;      // the primitive refuses
            started++;
            g.finishStep("flaky step", false, "boom");
        }
        chk("startStep is refused once the attempt budget is spent", started == 3,
                "started=" + started);
        chk("the attempt counter stops exactly at the limit", g.steps.get(0).attempts == 3,
                "attempts=" + g.steps.get(0).attempts);
        chk("retryStep also refuses past the limit", !g.retryStep("flaky step", 3),
                "attempts=" + g.steps.get(0).attempts);
        chk("the budget travels with the task through JSON",
                TaskRecord.fromJson(g.toJson()).maxStepAttempts == g.maxStepAttempts,
                "max=" + TaskRecord.fromJson(g.toJson()).maxStepAttempts);

        System.out.println("\n== an unfinished task never reads as finished ==");
        TaskRecord n = fresh();
        n.moveTo(TaskRecord.Phase.EXECUTING);
        n.startStep("fetch data");
        String rep = n.finalReport();
        chk("the report says NOT FINISHED", rep.contains("NOT FINISHED"), firstLine(rep, "NOT FINISHED"));
        chk("the report names the phase it stopped in", rep.contains("EXECUTING"), "EXECUTING");
        chk("the report does not claim success", !rep.contains("State: COMPLETED"), "no COMPLETED");

        System.out.println("\n== the report carries everything the user is owed ==");
        TaskRecord full = fresh();
        full.engine = "b";
        full.moveTo(TaskRecord.Phase.EXECUTING);
        full.startStep("fetch data");
        full.finishStep("fetch data", true, "12 rows");
        full.recordCommand("python3 build.py", 0, "wrote widget.json");
        full.recordCommand("pytest -q", 1, "2 failed");
        full.recordArtifact("/tmp/widget.json", "created", 12);
        full.recordResult("12 rows transformed");
        full.recordError("pytest: 2 failed");
        full.noteRemaining("the two failing tests");
        full.startStep("transform");
        full.finishStep("transform", true, "ok");
        full.startStep("write file");
        full.finishStep("write file", true, "ok");
        full.moveTo(TaskRecord.Phase.VALIDATING);
        full.recordCheck("widget.json parses");
        full.complete();
        String fr = full.finalReport();
        for (String section : new String[]{"Task:", "State: COMPLETED", "Steps", "Verified",
                "Files", "Commands run", "Results", "Errors", "Still open", "Engine: B"}) {
            chk("report contains " + section, fr.contains(section), section);
        }
        chk("report records both exit codes",
                fr.contains("exit 0") && fr.contains("exit 1"), "exit 0 / exit 1");

        System.out.println("\n== persistence survives a round trip ==");
        JSONObject j1 = full.toJson();
        TaskRecord back = TaskRecord.fromJson(j1);
        chk("phase survives", back.phase == full.phase, back.phase.name());
        chk("goal survives", back.goal.equals(full.goal), back.goal);
        chk("step count survives", back.steps.size() == full.steps.size(),
                back.steps.size() + " steps");
        chk("step statuses survive",
                back.steps.get(0).status.equals(full.steps.get(0).status),
                back.steps.get(0).status);
        chk("artifacts survive", back.artifacts.size() == 1
                && back.artifacts.get(0).path.equals("/tmp/widget.json")
                && back.artifacts.get(0).bytes == 12, String.valueOf(back.artifacts.get(0).path));
        chk("commands survive with exit codes",
                back.commands.size() == 2 && back.commands.get(1).exitCode == 1,
                "exit=" + back.commands.get(1).exitCode);
        chk("checks survive", back.checks.equals(full.checks), String.valueOf(back.checks));
        chk("remaining issues survive", back.remaining.equals(full.remaining),
                String.valueOf(back.remaining));
        chk("engine survives", "b".equals(back.engine), String.valueOf(back.engine));
        chk("a round-tripped terminal task is still terminal", back.isTerminal(), back.phase.name());
        chk("an unknown phase falls back rather than throwing",
                TaskRecord.fromJson(new JSONObject("{\"id\":\"x\",\"phase\":\"NONSENSE\"}").put("goal", "g"))
                        .phase == TaskRecord.Phase.PLANNING, "fell back to PLANNING");

        System.out.println("\n== the handoff only claims what actually happened ==");
        TaskRecord h = new TaskRecord("t5", "migrate the data");
        h.plan("extract", "load", "verify");
        h.moveTo(TaskRecord.Phase.EXECUTING);
        h.startStep("extract");
        h.finishStep("extract", true, "900 rows");
        h.recordArtifact("/kaggle/working/rows.csv", "created", 4096);
        h.startStep("load");
        h.finishStep("load", false, "connection reset");
        h.recordError("load failed: connection reset");
        String ho = h.handoff();
        chk("the handoff says continue, not restart", ho.contains("CONTINUE THIS TASK"),
                firstLine(ho, "CONTINUE"));
        chk("the handoff lists the completed step as done", ho.contains("- extract (900 rows)"),
                "extract");
        chk("the handoff does NOT claim the failed step is done",
                !ho.contains("- load (connection reset)"), "load not in done list");
        chk("the handoff lists the failed step as not finished",
                ho.contains("- load [failed]"), "load [failed]");
        chk("the handoff carries the files already on the engine",
                ho.contains("/kaggle/working/rows.csv"), "rows.csv");
        chk("the handoff carries the failure so it is not repeated",
                ho.contains("connection reset"), "connection reset");

        System.out.println("\n" + passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }

    static String firstLine(String hay, String needle) {
        for (String l : hay.split("\n")) if (l.contains(needle)) return l.trim();
        return "(not found)";
    }
}
