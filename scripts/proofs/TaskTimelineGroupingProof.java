import com.aether.app.core.AgentActivity;
import com.aether.app.core.AgentRun;

import java.util.List;

/**
 * Proof for the agent timeline's organisation rules, on the real classes.
 *
 * The events below are the engine's own formats (see AgentActivity's header),
 * fed through the same parser the app uses, so this covers grouping of real
 * steps rather than of hand-built objects.
 *
 * What must hold:
 *   1. Phases follow the order things actually happened, never a tidier order.
 *   2. Only consecutive steps of a kind merge; a return to an earlier kind
 *      opens a new phase instead of being folded backwards.
 *   3. Nothing is invented: no steps means no phases, and a tool the parser
 *      does not know is shown as "Working", not guessed into a category.
 *   4. Counts and durations come from the steps, so the header can never claim
 *      more work than was reported.
 */
public final class TaskTimelineGroupingProof {
    static int pass, fail;
    static void check(String name, boolean ok, Object detail) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + name + "  [" + detail + "]");
        if (ok) pass++; else fail++;
    }

    static AgentActivity run(String... events) {
        AgentActivity model = new AgentActivity();
        for (String event : events) model.feed(event);
        return model;
    }

    public static void main(String[] args) {
        // ---- 1. a real recorded shape: search, read, then run a command ------
        AgentActivity model = run(
                "\u2699\ufe0f agent step 1...",
                "\ud83d\udee0\ufe0f web_search({\"query\": \"Nigeria top news headline today\"})",
                "\u21b3 web_search returned 1204 chars",
                "\ud83d\udee0\ufe0f fetch_page({\"url\": \"https://www.premiumtimesng.com/\"})",
                "\u21b3 fetch_page returned 12045 chars",
                "\ud83d\udee0\ufe0f run_command({\"command\": \"pwd\"})",
                "\u21b3 run_command returned 24 chars");
        // Grouping shape first, with the reasoning lead excluded so the phase
        // indexes below are about the tools alone.
        List<AgentRun.Phase> phases = AgentRun.of(model.steps(), false, false);
        check("three reported steps produce three timeline rows", model.steps().size() == 3, model.steps().size());
        List<AgentRun.Phase> withLeadFromRealEvents = AgentRun.of(model.steps(), model.hasReasoning(), false);
        check("the real event stream adds a reasoning lead block",
                model.hasReasoning() && withLeadFromRealEvents.size() == 3
                        && withLeadFromRealEvents.get(0).kind == AgentRun.Kind.REASONING
                        && withLeadFromRealEvents.get(0).synthetic,
                withLeadFromRealEvents.get(0).kind + " lead, " + withLeadFromRealEvents.size() + " phases");
        check("search and read merge into one gathering phase", phases.size() == 2, phases.size() + " phases");
        check("first phase is gathering", phases.get(0).kind == AgentRun.Kind.GATHER, phases.get(0).kind);
        check("second phase is executing", phases.get(1).kind == AgentRun.Kind.EXECUTE, phases.get(1).kind);
        check("gathering phase holds both reads", phases.get(0).total() == 2, phases.get(0).total());
        check("every step is accounted for exactly once",
                phases.get(0).total() + phases.get(1).total() == model.steps().size(), "no loss, no duplication");
        check("count label reports completion honestly",
                phases.get(0).countLabel().equals("2 steps"), phases.get(0).countLabel());
        check("duration is the sum of the reported steps",
                phases.get(0).durationMs() == model.steps().get(0).durationMs + model.steps().get(1).durationMs,
                phases.get(0).durationMs() + "ms");
        check("titles are human", "Gathering information".equals(phases.get(0).title())
                && "Running commands".equals(phases.get(1).title()), phases.get(0).title() + " / " + phases.get(1).title());

        // ---- 2. returning to an earlier kind opens a NEW phase, in order ----
        AgentActivity backAndForth = run(
                "\ud83d\udee0\ufe0f web_search({\"query\": \"a\"})", "\u21b3 web_search returned 10 chars",
                "\ud83d\udee0\ufe0f run_command({\"command\": \"ls\"})", "\u21b3 run_command returned 10 chars",
                "\ud83d\udee0\ufe0f web_search({\"query\": \"b\"})", "\u21b3 web_search returned 10 chars");
        List<AgentRun.Phase> zigzag = AgentRun.of(backAndForth.steps(), false, false);
        check("grouping follows chronology, not category", zigzag.size() == 3, zigzag.size() + " phases");
        check("order is GATHER, EXECUTE, GATHER",
                zigzag.get(0).kind == AgentRun.Kind.GATHER && zigzag.get(1).kind == AgentRun.Kind.EXECUTE
                        && zigzag.get(2).kind == AgentRun.Kind.GATHER,
                zigzag.get(0).kind + ", " + zigzag.get(1).kind + ", " + zigzag.get(2).kind);

        // ---- 3. nothing is invented -----------------------------------------
        check("no steps and no reasoning yields no phases",
                AgentRun.of(new AgentActivity().steps(), false, true).isEmpty(), "empty run");
        List<AgentRun.Phase> reasoningOnly = AgentRun.of(new AgentActivity().steps(), true, true);
        check("reasoning alone shows exactly one lead block", reasoningOnly.size() == 1, reasoningOnly.size());
        check("the reasoning block is marked synthetic, so it never claims steps",
                reasoningOnly.get(0).synthetic && reasoningOnly.get(0).total() == 0, "synthetic");

        AgentActivity unknown = new AgentActivity();
        unknown.feed("\ud83d\udee0\ufe0f some_new_tool({\"x\": 1})");
        List<AgentRun.Phase> other = AgentRun.of(unknown.steps(), false, false);
        check("an unrecognised tool is still shown", other.size() == 1 && other.get(0).total() == 1, other.size());
        check("an unrecognised tool is not guessed into a category",
                other.get(0).kind == AgentRun.Kind.OTHER && "Working".equals(other.get(0).title()),
                other.get(0).kind);

        // a tool that never reports back must not be counted as done
        AgentActivity stuck = run("\ud83d\udee0\ufe0f run_command({\"command\": \"sleep 60\"})");
        List<AgentRun.Phase> stuckPhases = AgentRun.of(stuck.steps(), false, true);
        check("an unfinished step keeps its phase live", stuckPhases.get(0).running, "running");
        check("an unfinished step is not counted as complete", stuckPhases.get(0).done() == 0,
                stuckPhases.get(0).done() + " done");
        check("an unfinished step has no duration to report", stuckPhases.get(0).durationMs() == 0,
                stuckPhases.get(0).durationMs() + "ms");
        check("partial progress reads as '0 of 1', not '1 step'",
                "0 of 1".equals(stuckPhases.get(0).countLabel()), stuckPhases.get(0).countLabel());

        // ---- 4. the reasoning block stops being the active one --------------
        AgentActivity thinking = run("\ud83e\udde0 reasoning about the task",
                "\ud83d\udee0\ufe0f web_search({\"query\": \"x\"})");
        List<AgentRun.Phase> withLead = AgentRun.of(thinking.steps(), thinking.hasReasoning(), true);
        check("reasoning leads the run", withLead.get(0).kind == AgentRun.Kind.REASONING, withLead.get(0).kind);
        check("once a tool runs, the reasoning block is no longer active",
                !withLead.get(0).running, "reasoning running=" + withLead.get(0).running);
        check("the tool phase is the active one", withLead.get(1).running, "tool running=" + withLead.get(1).running);

        check("open steps are counted across phases", AgentRun.openSteps(withLead) == 1, AgentRun.openSteps(withLead));
        check("total duration spans every phase",
                AgentRun.totalDurationMs(phases) == phases.get(0).durationMs() + phases.get(1).durationMs(),
                AgentRun.totalDurationMs(phases) + "ms");

        System.out.println("\nTASK TIMELINE GROUPING PROOF  " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }
}
