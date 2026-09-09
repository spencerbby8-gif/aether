import com.aether.app.core.AgentActivity;
import com.aether.app.core.ChatSession;
import com.aether.app.core.TaskRecord;
import com.aether.app.core.TaskTracker;

/**
 * A chat turn mapped onto a task lifecycle.
 *
 * The activity is driven with the literal strings the kernel emits, not with
 * hand-built Step objects, so this proves the real parsing path: a tool that
 * reported "returned N chars" becomes a done step, and a tool the engine let go
 * of mid-flight becomes a FAILED step rather than being quietly called done.
 *
 * The claims that matter are the negative ones -- that a turn which reported
 * done:true but sent no text is NOT marked complete, and that nothing can leave
 * close() in a non-terminal phase.
 *
 * Run: java -cp /tmp/jvm-suite TaskTrackerProof
 */
public class TaskTrackerProof {
    static int passed = 0, failed = 0;

    static void chk(String what, boolean ok, String seen) {
        System.out.println("  " + (ok ? "ok  " + what : "FAIL " + what) + "   [" + seen + "]");
        if (ok) passed++; else failed++;
    }

    /** The real kernel event strings. */
    static final String STEP = "\u2699\ufe0f agent step 1...";
    static final String BEAT = "\u23f3";

    static AgentActivity searchThenDone() {
        AgentActivity a = new AgentActivity();
        a.feed(STEP);
        a.feed("\ud83d\udee0\ufe0f web_search({\"query\": \"Nigeria news today\"})");
        a.feed(BEAT);
        a.feed("\u21b3 web_search returned 1840 chars");
        return a;
    }

    static AgentActivity searchAbandoned() {
        AgentActivity a = new AgentActivity();
        a.feed(STEP);
        a.feed("\ud83d\udee0\ufe0f run_command({\"command\": \"pip install pandas\"})");
        a.feed(BEAT);
        return a;      // never reported back: the engine let go mid-tool
    }

    public static void main(String[] args) throws Exception {
        System.out.println("== a turn becomes a task ==");
        ChatSession s = new ChatSession("c1", "New chat");
        s.engine = "b";
        chk("a fresh session has no task", s.task == null, String.valueOf(s.task));
        TaskRecord t = TaskTracker.begin(s, "Find today's headline and save it");
        chk("begin creates a task", t != null && s.task == t, "created");
        chk("the goal is the user's prompt",
                "Find today's headline and save it".equals(t.goal), t.goal);
        chk("the task inherits the engine it started on", "b".equals(t.engine),
                String.valueOf(t.engine));
        chk("it starts in PLANNING", t.phase == TaskRecord.Phase.PLANNING, t.phase.name());

        System.out.println("\n== an unfinished task is continued, not replaced ==");
        TaskRecord again = TaskTracker.begin(s, "and now summarise it");
        chk("a non-terminal task is reused", again == t, "same record");
        t.moveTo(TaskRecord.Phase.EXECUTING);
        t.startStep("draft");
        t.finishStep("draft", true, "ok");
        t.moveTo(TaskRecord.Phase.VALIDATING);
        t.recordCheck("read back the file");
        t.complete();
        TaskRecord next = TaskTracker.begin(s, "a brand new job");
        chk("a finished task makes way for a new one", next != t, "new record");
        chk("the new task has the new goal", "a brand new job".equals(next.goal), next.goal);

        System.out.println("\n== real activity is mirrored into the task ==");
        ChatSession s2 = new ChatSession("c2", "research");
        TaskRecord r = TaskTracker.begin(s2, "search the news");
        int n = TaskTracker.mirror(r, searchThenDone());
        chk("the tool the agent ran became a step", n == 1, n + " step(s) mirrored");
        chk("a tool that reported back is DONE",
                r.steps.size() == 1 && TaskRecord.Step.DONE.equals(r.steps.get(0).status),
                r.steps.isEmpty() ? "none" : r.steps.get(0).status);
        chk("what it returned is recorded",
                !r.steps.isEmpty() && r.steps.get(0).detail.contains("1840 chars"),
                r.steps.isEmpty() ? "" : r.steps.get(0).detail);
        chk("mirroring moves the task into EXECUTING",
                r.phase == TaskRecord.Phase.EXECUTING, r.phase.name());

        TaskRecord r2 = TaskTracker.begin(new ChatSession("c3", "x"), "install a package");
        TaskTracker.mirror(r2, searchAbandoned());
        chk("a tool the engine abandoned is FAILED, never DONE",
                r2.steps.size() == 1 && TaskRecord.Step.FAILED.equals(r2.steps.get(0).status),
                r2.steps.isEmpty() ? "none" : r2.steps.get(0).status);
        chk("the reason says the turn ended mid-tool",
                !r2.steps.isEmpty() && r2.steps.get(0).detail.contains("turn ended"),
                r2.steps.isEmpty() ? "" : r2.steps.get(0).detail);

        System.out.println("\n== every close reaches a terminal state ==");
        for (Object[] c : new Object[][]{
                {Boolean.TRUE, null, "Here is the headline you asked for.", "COMPLETED"},
                {Boolean.FALSE, "cancelled", "partial text", "CANCELLED"},
                {Boolean.FALSE, "HTTP 530 tunnel gone", "", "FAILED"},
                {Boolean.FALSE, null, "", "FAILED"},
                {Boolean.TRUE, null, "", "FAILED"},          // done:true but no text
        }) {
            TaskRecord x = TaskTracker.begin(new ChatSession("z", "z"), "do the thing");
            TaskTracker.mirror(x, searchThenDone());
            TaskTracker.close(x, (Boolean) c[0], (String) c[1], (String) c[2], 12_000);
            chk("ok=" + c[0] + " err=" + c[1] + " chars=" + ((String) c[2]).length()
                            + " -> " + c[3],
                    x.phase.name().equals(c[3]) && x.isTerminal(), x.phase.name());
        }

        System.out.println("\n== success has to be verified, not assumed ==");
        TaskRecord good = TaskTracker.begin(new ChatSession("g", "g"), "write the report");
        TaskTracker.mirror(good, searchThenDone());
        TaskTracker.close(good, true, null, "Here is the report, with sources.", 9_000);
        chk("a real answer completes the task", good.phase == TaskRecord.Phase.COMPLETED,
                good.phase.name());
        chk("completion records what was actually verified",
                !good.checks.isEmpty() && good.checks.get(0).contains("chars"),
                good.checks.isEmpty() ? "(none)" : good.checks.get(0));

        TaskRecord empty = TaskTracker.begin(new ChatSession("e", "e"), "write the report");
        TaskTracker.close(empty, true, null, "   ", 4_000);
        chk("done:true with no answer text is NOT completed",
                empty.phase == TaskRecord.Phase.FAILED, empty.phase.name());
        chk("the report explains why", empty.errors.toString().contains("no answer text"),
                empty.errors.toString());

        TaskRecord failedStep = TaskTracker.begin(new ChatSession("f", "f"), "install pandas");
        TaskTracker.mirror(failedStep, searchAbandoned());
        TaskTracker.close(failedStep, true, null, "Sure, here you go.", 6_000);
        chk("a failed step blocks completion even when the turn looked fine",
                failedStep.phase == TaskRecord.Phase.FAILED, failedStep.phase.name());

        System.out.println("\n== a stopped turn keeps what it had ==");
        TaskRecord stopped = TaskTracker.begin(new ChatSession("s", "s"), "long job");
        TaskTracker.mirror(stopped, searchThenDone());
        TaskTracker.close(stopped, false, "cancelled", "Half of the answer arrived here.", 20_000);
        chk("a stopped task is CANCELLED", stopped.phase == TaskRecord.Phase.CANCELLED,
                stopped.phase.name());
        chk("the partial answer is recorded, not thrown away",
                stopped.results.toString().contains("partial answer kept"),
                stopped.results.toString());
        chk("what is left is stated", stopped.remaining.toString().contains("stopped by the user"),
                stopped.remaining.toString());

        System.out.println("\n== close is idempotent ==");
        TaskRecord twice = TaskTracker.begin(new ChatSession("t", "t"), "job");
        TaskTracker.close(twice, true, null, "a perfectly good answer here", 3_000);
        TaskRecord.Phase first = twice.phase;
        TaskTracker.close(twice, false, "late error", "", 1);
        chk("a second close cannot rewrite a finished task", twice.phase == first,
                twice.phase.name());

        System.out.println("\n== the record survives being written to disk ==");
        ChatSession round = new ChatSession("c9", "persisted");
        TaskRecord pt = TaskTracker.begin(round, "the persisted job");
        pt.engine = "c";
        TaskTracker.mirror(pt, searchThenDone());
        TaskTracker.close(pt, true, null, "done and verified", 5_000);
        round.task = pt;
        ChatSession back = ChatSession.fromJson(round.toJson());
        chk("the session carries the task back", back.task != null, "present");
        chk("the task phase survives", back.task.phase == TaskRecord.Phase.COMPLETED,
                back.task == null ? "-" : back.task.phase.name());
        chk("the verified checks survive", back.task.checks.equals(pt.checks),
                String.valueOf(back.task.checks));
        chk("the mirrored step survives as done",
                back.task.steps.size() == 1
                        && TaskRecord.Step.DONE.equals(back.task.steps.get(0).status),
                back.task.steps.isEmpty() ? "none" : back.task.steps.get(0).status);

        System.out.println("\n== an old session with no task still loads ==");
        ChatSession legacy = ChatSession.fromJson(
                new org.json.JSONObject("{\"v\":1,\"id\":\"old\",\"title\":\"Old chat\"}"));
        chk("a pre-task session loads with a null task", legacy.task == null,
                String.valueOf(legacy.task));
        chk("and it can still start one",
                TaskTracker.begin(legacy, "resume here") != null, "created");

        System.out.println("\n" + passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }
}
