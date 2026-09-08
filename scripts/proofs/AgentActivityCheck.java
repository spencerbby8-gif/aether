import com.aether.app.core.AgentActivity;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.List;

/**
 * Proves the activity mapper against the engine's REAL streamed events.
 *
 * The fixture is not hand-written. It is captured byte-for-byte from a live
 * engine by scripts/proofs/capture-agent-events.py: each line is
 * "<seconds since request> <one NDJSON line the kernel sent>". Replaying it
 * through AgentActivity is what makes these assertions runtime evidence rather
 * than a reading of the source.
 *
 *   java -cp <out>:<json jar> AgentActivityCheck <fixture.ndjson>
 */
public final class AgentActivityCheck {

    static int pass = 0, fail = 0;

    public static void main(String[] args) throws Exception {
        System.out.println("== agent activity mapping ==");
        if (args.length < 1) {
            System.out.println("usage: AgentActivityCheck <fixture.ndjson>");
            System.exit(2);
        }
        List<String> lines = Files.readAllLines(Paths.get(args[0]), StandardCharsets.UTF_8);
        System.out.println("fixture: " + args[0] + "  (" + lines.size() + " real event lines)\n");

        replayedFromTheRealEngine(lines);
        reasoningIsNeverShown();
        nothingIsInvented();
        sourcesArePreservedButNotDumped();
        truncatedArgumentsStillYieldADetail();
        persistenceRoundTrip();
        browserActionsReadAsCleanStates();
        reasoningIsReportedButNeverShown();

        System.out.println("\n" + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    /** The whole point: real events in, human activity out. */
    static void replayedFromTheRealEngine(List<String> lines) throws Exception {
        AgentActivity a = new AgentActivity();
        int thinking = 0, shown = 0, content = 0;
        String firstContentAt = null;
        for (String l : lines) {
            int sp = l.indexOf(' ');
            if (sp < 0) continue;
            String at = l.substring(0, sp);
            JSONObject o;
            try { o = new JSONObject(l.substring(sp + 1)); } catch (Exception e) { continue; }
            JSONObject m = o.optJSONObject("message");
            if (m == null) continue;
            String th = m.optString("thinking", "");
            if (!th.isEmpty()) {
                thinking++;
                if (a.feed(th)) shown++;
            }
            if (!m.optString("content", "").isEmpty()) {
                content++;
                if (firstContentAt == null) firstContentAt = at;
                a.noteContent();
            }
        }
        a.finish();
        System.out.println("  real turn: " + thinking + " thinking events, " + shown
                + " recognised as activity, " + content + " content deltas");
        for (AgentActivity.Step s : a.steps()) {
            System.out.println("    " + s.label + (s.detail.isEmpty() ? "" : "  [" + s.detail + "]")
                    + "  " + s.durationMs + "ms" + (s.chars > 0 ? "  " + s.chars + " chars" : ""));
        }

        check("the engine sent thinking events", thinking > 0, thinking + "");
        /* Many events must collapse into few rows. A turn that searched four
           times and read a page emits 21 thinking events -- heartbeats every
           10s, one line per iteration, a start and a finish per tool -- and
           the conversation should carry five short lines, not twenty-one. */
        check("events collapse into far fewer rows", a.steps().size() * 2 < thinking,
                a.steps().size() + " rows from " + thinking + " events");
        check("at least one real activity was recognised", !a.steps().isEmpty(),
                a.steps().size() + " step(s)");
        for (AgentActivity.Step s : a.steps()) {
            check("a label is short and human: \"" + s.label + "\"",
                    s.label.length() <= 24 && s.label.charAt(0) == Character.toUpperCase(s.label.charAt(0)),
                    s.label);
            check("no raw JSON in the detail of \"" + s.label + "\"",
                    !s.detail.contains("{") && !s.detail.contains("\"")
                            && !s.detail.contains("http"),
                    "\"" + s.detail + "\"");
            check("no tool identifier leaks into \"" + s.label + "\"",
                    !s.label.contains("_") && !s.label.contains("("), s.label);
        }
        check("the summary is compact", a.summary().length() <= 80, "\"" + a.summary() + "\"");
        check("the summary reads as past tense", a.summary().startsWith("Searched")
                || a.summary().startsWith("Read") || a.summary().startsWith("Ran")
                || a.summary().startsWith("Generated") || a.summary().startsWith("Used"),
                "\"" + a.summary() + "\"");
        check("the first content token was seen", firstContentAt != null,
                firstContentAt == null ? "none" : "t+" + firstContentAt + "s");
    }

    /** The kernel streams the model's reasoning as a thinking event. Drop it. */
    static void reasoningIsNeverShown() {
        AgentActivity a = new AgentActivity();
        String reasoning = "The user wants current weather. I should call web_search "
                + "with query \"Lagos weather\" and then summarise the results.";
        check("the model's reasoning is not shown", !a.feed(reasoning), "dropped");
        check("reasoning produced no activity", a.steps().isEmpty(), a.steps().size() + "");
        /* The kernel truncates tool arguments at 180 chars, so a reasoning line
           can look almost like a tool call. Only the marker or a known tool
           name may start a step. */
        check("a stray word with brackets is not a tool call",
                !a.feed("I will call foo(1) and see"), "dropped");
    }

    /** No step may exist unless the engine announced one. */
    static void nothingIsInvented() {
        AgentActivity a = new AgentActivity();
        check("a heartbeat alone creates no activity", a.feed("\u23f3") && a.steps().isEmpty(),
                a.steps().size() + " steps");
        check("a heartbeat alone is not 'searching'",
                !"Searching the web".equals(a.labelNow()), a.labelNow());
        a.feed("\u2699\ufe0f agent step 1...");
        check("an iteration alone reads as Thinking", "Thinking".equals(a.labelNow()), a.labelNow());
        check("an iteration alone creates no step", a.steps().isEmpty(), a.steps().size() + "");
        check("a turn with no tools has no summary", a.summary().isEmpty(), "\"" + a.summary() + "\"");
    }

    static void sourcesArePreservedButNotDumped() {
        AgentActivity a = new AgentActivity();
        a.feed("\ud83d\udee0\ufe0f fetch_page({\"url\": \"https://www.bbc.com/news/world-12345\"})");
        check("a fetched page becomes a readable activity",
                "Reading a source".equals(a.labelNow()), a.labelNow());
        check("its detail is the host, not the URL",
                "www.bbc.com".equals(a.steps().get(0).detail), a.steps().get(0).detail);
        check("the real URL is still kept for citation",
                a.sources().contains("https://www.bbc.com/news/world-12345"),
                a.sources().toString());
        a.feed("\u21b3 fetch_page returned 8123 chars");
        check("the step closes with a measured duration",
                a.steps().get(0).done && a.steps().get(0).durationMs >= 0,
                a.steps().get(0).durationMs + "ms");
        check("the byte count is kept, not shown as a log",
                a.steps().get(0).chars == 8123, a.steps().get(0).chars + " chars");
    }

    /** The kernel cuts arguments at 180 chars, so the JSON is often invalid. */
    static void truncatedArgumentsStillYieldADetail() {
        AgentActivity a = new AgentActivity();
        a.feed("\ud83d\udee0\ufe0f web_search({\"query\": \"current price of Brent crude oil today"
                + " and how it moved over the last week\", \"max_results\": 5");
        check("a truncated argument blob still gives a query",
                !a.steps().isEmpty() && !a.steps().get(0).detail.isEmpty(),
                a.steps().isEmpty() ? "no step" : "\"" + a.steps().get(0).detail + "\"");
        check("the detail is clipped, not dumped",
                a.steps().get(0).detail.length() <= 60, a.steps().get(0).detail.length() + " chars");
        check("an unknown tool with the marker is still shown, generically",
                AgentActivity.labelFor("some_new_tool").equals("Using a tool"),
                AgentActivity.labelFor("some_new_tool"));
    }

    /** Activities must survive a save and reload, or history loses them. */
    static void persistenceRoundTrip() throws Exception {
        AgentActivity a = new AgentActivity();
        a.feed("\ud83d\udee0\ufe0f web_search({\"query\": \"Lagos traffic today\"})");
        a.feed("\u21b3 web_search returned 2048 chars");
        a.feed("\ud83d\udee0\ufe0f run_command({\"command\": \"date -u\"})");
        a.feed("\u21b3 run_command returned 31 chars");
        a.finish();
        List<AgentActivity.Step> back = AgentActivity.fromJson(a.toJson());
        check("every step survives a reload", back.size() == a.steps().size(),
                back.size() + " of " + a.steps().size());
        check("labels survive a reload",
                "Searching the web".equals(back.get(0).label), back.get(0).label);
        check("durations survive a reload", back.get(0).done, back.get(0).durationMs + "ms");
        check("a two-tool turn summarises both",
                a.summary().contains("Searched") && a.summary().contains("Ran"),
                "\"" + a.summary() + "\"");
    }

    /**
     * The engine reports one tool named "browser" for every action, so the verb
     * has to come from the action argument. Otherwise a whole sign-in flow
     * would read as "Using a tool" over and over.
     */
    static void browserActionsReadAsCleanStates() {
        System.out.println();
        System.out.println("== browser activity reads as clean states ==");
        AgentActivity a = new AgentActivity();
        check("opening a site", a.feed("\ud83d\udee0\ufe0f browser({\"action\":\"navigate\",\"url\":\"https://example.com/signin\"})"), "accepted");
        check("the label is 'Opening site', not 'Using a tool'",
                "Opening site".equals(a.labelNow()), a.labelNow());
        check("filling a form", a.feed("\ud83d\udee0\ufe0f browser({\"action\":\"fill\",\"selector\":\"#email\"})"), "accepted");
        check("the label is 'Filling form'", "Filling form".equals(a.labelNow()), a.labelNow());
        a.feed("\u21b3 browser returned 84 chars");
        check("waiting", a.feed("\ud83d\udee0\ufe0f browser({\"action\":\"wait\",\"selector\":\"#dash\"})"), "accepted");
        check("the label is 'Waiting'", "Waiting".equals(a.labelNow()), a.labelNow());
        a.feed("\u21b3 browser returned 20 chars");
        check("a screenshot", a.feed("\ud83d\udee0\ufe0f browser({\"action\":\"screenshot\"})"), "accepted");
        check("the label is 'Taking a screenshot'",
                "Taking a screenshot".equals(a.labelNow()), a.labelNow());
        a.feed("\u21b3 browser returned 90 chars");
        a.finish();
        String summary = a.summary();
        check("the finished summary is past tense and browser-specific",
                summary.contains("Opened site") && summary.contains("Filled form"), summary);
        check("the summary never says 'Used a tool' for a browser step",
                !summary.contains("Used a tool"), summary);

        /* The verb lives in the arguments, which are not kept, so the finished
           wording has to survive being written to and read back from storage. */
        AgentActivity b = new AgentActivity();
        b.feed("\ud83d\udee0\ufe0f browser({\"action\":\"navigate\",\"url\":\"https://example.com\"})");
        b.feed("\u21b3 browser returned 60 chars");
        b.finish();
        List<AgentActivity.Step> back = AgentActivity.fromJson(b.toJson());
        check("the past wording survives a save and reload",
                !back.isEmpty() && "Opened site".equals(back.get(0).past),
                back.isEmpty() ? "no steps" : back.get(0).past);
    }

    /**
     * Reasoning has to be visible as a state, and invisible as content. The
     * engine sends a marker when the model starts thinking; the text never
     * arrives. A turn that did not think must not claim it did -- that is the
     * difference between a truthful state and decoration.
     */
    static void reasoningIsReportedButNeverShown() {
        System.out.println();
        System.out.println("== reasoning is reported, never shown ==");

        AgentActivity a = new AgentActivity();
        a.feed("\u2699\ufe0f agent step 1...");
        check("before any reasoning it says Thinking, not Reasoning",
                "Thinking".equals(a.labelNow()), a.labelNow());
        a.feed("\ud83e\udde0");
        check("the marker turns the state to Reasoning",
                "Reasoning".equals(a.labelNow()), a.labelNow());
        check("the marker is consumed, not shown as text",
                !a.labelNow().contains("\ud83e\udde0"), a.labelNow());
        a.feed("Some private reasoning about the answer.");
        check("stray reasoning text is still dropped",
                "Reasoning".equals(a.labelNow()) && a.steps().isEmpty(), a.labelNow());
        a.noteContent();
        check("once the answer starts it says Writing",
                "Writing".equals(a.labelNow()), a.labelNow());

        /* The truthfulness half: no marker, no claim. */
        AgentActivity b = new AgentActivity();
        b.feed("\u2699\ufe0f agent step 1...");
        b.feed("\u23f3");
        check("a turn that never reasoned never says Reasoning",
                !"Reasoning".equals(b.labelNow()), b.labelNow());

        /* A tool in flight outranks the reasoning label. */
        AgentActivity c = new AgentActivity();
        c.feed("\ud83e\udde0");
        c.feed("\ud83d\udee0\ufe0f web_search({\"query\": \"x\"})");
        check("an open tool outranks the reasoning label",
                "Searching the web".equals(c.labelNow()), c.labelNow());

        /* browser is part of the kernel's tool table now, so it is recognised
           even without the marker. */
        AgentActivity d = new AgentActivity();
        check("browser is a known tool", d.feed("browser({\"action\": \"navigate\"})"), "accepted");
        check("and its verb comes from the action argument",
                "Opening site".equals(d.labelNow()), d.labelNow());
    }

    static void check(String what, boolean ok, String seen) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + what + "   [" + seen + "]");
        if (ok) pass++; else fail++;
    }

    static {
        try { Class.forName("java.nio.file.Files"); } catch (Exception ignored) { }
    }

    @SuppressWarnings("unused")
    private static void unused() throws IOException { }
}
