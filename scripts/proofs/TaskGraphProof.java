import com.aether.app.core.TaskGraph;
import com.aether.app.core.TaskGraph.Node;
import com.aether.app.core.TaskGraph.Spec;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * The dependency graph under a task plan.
 *
 * The interesting assertions are the negative ones: that a plan waiting on a
 * step which does not exist is rejected at build time rather than hanging, that
 * a cycle is named instead of deadlocking silently, and that a failed step
 * cancels the work downstream of it rather than leaving it pending forever.
 *
 * Run: java -cp /tmp/jvm-suite TaskGraphProof
 */
public class TaskGraphProof {
    static int passed = 0, failed = 0;

    static void chk(String what, boolean ok, String seen) {
        System.out.println("  " + (ok ? "ok  " + what : "FAIL " + what) + "   [" + seen + "]");
        if (ok) passed++; else failed++;
    }

    static List<Spec> specs(Spec... s) { return new ArrayList<>(Arrays.asList(s)); }

    static String ids(List<Node> ns) {
        StringBuilder sb = new StringBuilder();
        for (Node n : ns) sb.append(sb.length() == 0 ? "" : ",").append(n.id);
        return sb.toString();
    }

    static String waves(TaskGraph g) {
        StringBuilder sb = new StringBuilder();
        for (List<String> w : g.waves()) sb.append(sb.length() == 0 ? "" : " | ").append(w);
        return sb.toString();
    }

    public static void main(String[] args) throws Exception {
        System.out.println("== a plan that cannot run is rejected, not hung ==");
        chk("an empty plan is refused", !TaskGraph.build(specs()).isValid(),
                String.valueOf(TaskGraph.build(specs()).buildError()));
        chk("a duplicate step id is refused",
                !TaskGraph.build(specs(new Spec("a", "A"), new Spec("a", "A again"))).isValid(),
                String.valueOf(TaskGraph.build(specs(new Spec("a", "A"), new Spec("a", "A again"))).buildError()));
        TaskGraph ghost = TaskGraph.build(specs(new Spec("a", "A", "nope")));
        chk("waiting on a step that does not exist is refused", !ghost.isValid(),
                String.valueOf(ghost.buildError()));
        chk("the refusal names the missing step",
                ghost.buildError() != null && ghost.buildError().contains("nope"),
                String.valueOf(ghost.buildError()));
        chk("a step waiting on itself is refused",
                !TaskGraph.build(specs(new Spec("a", "A", "a"))).isValid(), "");
        TaskGraph cyc = TaskGraph.build(specs(
                new Spec("a", "A", "c"), new Spec("b", "B", "a"), new Spec("c", "C", "b")));
        chk("a circular plan is refused", !cyc.isValid(), String.valueOf(cyc.buildError()));
        chk("the cycle is named, not just reported",
                cyc.buildError() != null && cyc.buildError().contains("circular"),
                String.valueOf(cyc.buildError()));
        chk("a forward reference is fine",
                TaskGraph.build(specs(new Spec("a", "A", "b"), new Spec("b", "B"))).isValid(),
                "built");

        System.out.println("\n== independent steps may run together ==");
        TaskGraph par = TaskGraph.build(specs(
                new Spec("src1", "search source one"),
                new Spec("src2", "search source two"),
                new Spec("src3", "search source three"),
                new Spec("cmp", "compare findings", "src1", "src2", "src3"),
                new Spec("rep", "write the report", "cmp")));
        chk("the graph built", par.isValid(), String.valueOf(par.buildError()));
        chk("all three searches are eligible at once", par.runnable().size() == 3,
                ids(par.runnable()));
        chk("the comparison is not eligible yet", ids(par.runnable()).contains("src1")
                && !ids(par.runnable()).contains("cmp"), ids(par.runnable()));
        chk("the schedule is 3 waves, not 5 serial steps", par.waves().size() == 3,
                waves(par));
        chk("wave 0 holds exactly the independent work",
                par.waves().get(0).size() == 3, String.valueOf(par.waves().get(0)));
        chk("the report comes last, alone",
                par.waves().get(2).size() == 1 && par.waves().get(2).contains("rep"),
                waves(par));

        System.out.println("\n== dependent steps keep their order ==");
        for (String id : new String[]{"src1", "src2", "src3"}) par.markRunning(id);
        chk("nothing new is eligible while they run", par.runnable().isEmpty(),
                ids(par.runnable()));
        par.markDone("src1", "found 4 results");
        chk("one of three done is not enough to compare", par.runnable().isEmpty(),
                "still blocked");
        par.markDone("src2", "found 6 results");
        chk("two of three is still not enough", par.runnable().isEmpty(), "still blocked");
        par.markDone("src3", "found 5 results");
        chk("all three done releases the comparison",
                par.runnable().size() == 1 && par.runnable().get(0).id.equals("cmp"),
                ids(par.runnable()));

        System.out.println("\n== a failed step cancels what needed it ==");
        par.markFailed("cmp", "the sources contradicted each other");
        int skipped = par.propagateFailure("cmp");
        chk("the downstream report is skipped, not left pending", skipped == 1,
                skipped + " skipped");
        chk("the skipped step says why",
                par.get("rep").error.contains("cmp"), par.get("rep").error);
        chk("the graph is fully settled", par.allSettled(), par.toString());
        chk("nothing is eligible and nothing is running", par.runnable().isEmpty(), "");
        chk("it is NOT reported as a deadlock -- it has a verdict",
                !par.isDeadlocked(), String.valueOf(par.isDeadlocked()));
        chk("the outcome is failed, never null", "failed".equals(par.outcome()),
                String.valueOf(par.outcome()));
        chk("the unfinished list names the real problem",
                par.unfinished().toString().contains("compare findings"),
                String.valueOf(par.unfinished()));

        System.out.println("\n== a clean run reaches completed ==");
        TaskGraph ok = TaskGraph.build(specs(
                new Spec("a", "A"), new Spec("b", "B"), new Spec("c", "C", "a", "b")));
        chk("a fresh graph has no outcome yet", ok.outcome() == null,
                String.valueOf(ok.outcome()));
        ok.markRunning("a"); ok.markDone("a", "ok");
        ok.markRunning("b"); ok.markDone("b", "ok");
        ok.markRunning("c"); ok.markDone("c", "ok");
        chk("every step done -> completed", "completed".equals(ok.outcome()), ok.outcome());
        chk("progress is 1.0", Math.abs(ok.progress() - 1.0) < 1e-9,
                String.valueOf(ok.progress()));
        chk("nothing is unfinished", ok.unfinished().isEmpty(),
                String.valueOf(ok.unfinished()));

        System.out.println("\n== deadlock is detected, not waited on ==");
        /* Only reachable if a cycle slips past build(), so this drives the states
           directly the way a bug would. */
        TaskGraph stuck = TaskGraph.build(specs(new Spec("a", "A"), new Spec("b", "B", "a")));
        stuck.markFailed("a", "boom");
        chk("before propagation the graph IS deadlocked", stuck.isDeadlocked(),
                stuck.toString());
        stuck.propagateFailure("a");
        chk("propagation resolves it into a verdict", !stuck.isDeadlocked(),
                String.valueOf(stuck.outcome()));
        chk("and the verdict is failed", "failed".equals(stuck.outcome()), stuck.outcome());

        System.out.println("\n== cancellation travels downstream ==");
        TaskGraph cancel = TaskGraph.build(specs(
                new Spec("build", "build it"),
                new Spec("test", "test it", "build"),
                new Spec("ship", "ship it", "test"),
                new Spec("docs", "write docs")));
        cancel.markDone("docs", "written");
        cancel.markFailed("build", "cancelled by the user");
        int n = cancel.propagateFailure("build");
        chk("both downstream steps are skipped", n == 2, n + " skipped");
        chk("the independent step is untouched",
                "done".equals(cancel.get("docs").state), cancel.get("docs").state);
        chk("the outcome is failed", "failed".equals(cancel.outcome()), cancel.outcome());

        System.out.println("\n== retry does not lose the graph ==");
        TaskGraph retry = TaskGraph.build(specs(
                new Spec("fetch", "fetch the page"), new Spec("parse", "parse it", "fetch")));
        retry.markRunning("fetch");
        retry.markFailed("fetch", "timeout");
        chk("one attempt recorded", retry.get("fetch").attempts == 1,
                String.valueOf(retry.get("fetch").attempts));
        retry.markPending("fetch");
        retry.markRunning("fetch");
        chk("a retry counts as a second attempt", retry.get("fetch").attempts == 2,
                String.valueOf(retry.get("fetch").attempts));
        retry.markDone("fetch", "200 OK");
        chk("the dependent becomes eligible after the retry",
                retry.runnable().size() == 1 && retry.runnable().get(0).id.equals("parse"),
                ids(retry.runnable()));

        System.out.println("\n== the spec's own workflows schedule correctly ==");
        TaskGraph code = TaskGraph.build(specs(
                new Spec("inspect", "inspect the project"),
                new Spec("install", "install dependencies", "inspect"),
                new Spec("modify", "modify the files", "inspect"),
                new Spec("run", "run it", "install", "modify"),
                new Spec("test", "run the tests", "run"),
                new Spec("build", "build the artifact", "test")));
        chk("inspect/install/modify/run/test/build built", code.isValid(),
                String.valueOf(code.buildError()));
        chk("install and modify are independent and parallel",
                code.waves().get(1).size() == 2, waves(code));
        chk("the run waits for both", code.waves().get(2).contains("run"), waves(code));
        /* inspect | install+modify | run | test | build. Six steps, five waves:
           only the install/modify pair collapses, because only those two are
           genuinely independent. The rest is a real chain and must stay serial. */
        chk("six steps take five waves, not six", code.waves().size() == 5, waves(code));
        chk("and the only parallel wave is the independent pair",
                code.waves().stream().filter(w -> w.size() > 1).count() == 1, waves(code));

        TaskGraph media = TaskGraph.build(specs(
                new Spec("gen", "generate the image"),
                new Spec("look", "inspect the result", "gen"),
                new Spec("revise", "revise it", "look"),
                new Spec("save", "save the final", "revise")));
        chk("a media chain is strictly ordered", media.waves().size() == 4, waves(media));
        for (List<String> w : media.waves()) {
            chk("wave " + w + " holds one step", w.size() == 1, String.valueOf(w));
        }

        System.out.println("\n== the graph survives being written to disk ==");
        TaskGraph rt = TaskGraph.build(specs(
                new Spec("a", "step A"), new Spec("b", "step B", "a")));
        rt.markRunning("a");
        rt.markDone("a", "result text");
        rt.markRunning("b");
        rt.markFailed("b", "engine dropped");
        TaskGraph back = TaskGraph.fromJson(rt.toJson());
        chk("the step count survives", back.size() == 2, String.valueOf(back.size()));
        chk("the dependency survives", back.get("b").deps.contains("a"),
                String.valueOf(back.get("b").deps));
        chk("the states survive", "done".equals(back.get("a").state)
                && "failed".equals(back.get("b").state), back.toString());
        chk("the attempt count survives", back.get("b").attempts == 1,
                String.valueOf(back.get("b").attempts));
        chk("the error text survives", back.get("b").error.equals("engine dropped"),
                back.get("b").error);
        chk("the outcome is the same after a round trip",
                String.valueOf(rt.outcome()).equals(String.valueOf(back.outcome())),
                String.valueOf(back.outcome()));
        chk("an invalid graph round-trips as invalid",
                !TaskGraph.fromJson(TaskGraph.build(specs()).toJson()).isValid(), "");

        System.out.println("\n" + passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }
}
