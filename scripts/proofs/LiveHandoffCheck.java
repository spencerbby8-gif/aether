import com.aether.app.EngineCore;
import com.aether.app.core.TaskRecord;

/**
 * Item 2, live: does a second engine CONTINUE a task another engine abandoned?
 *
 * This is not a mock. It builds a TaskRecord exactly as a real interrupted turn
 * leaves one, asks the real TaskRecord.continuationPrompt for the string the app
 * would send, and puts that string through the real EngineCore.chatStream --
 * the same method ChatActivity calls -- against a live engine.
 *
 * The claim under test is the one that is easy to fake and hard to get right:
 * that the new engine picks up where the last one stopped instead of answering
 * the same question again from the top.
 *
 * Run: java -cp /tmp/jvm-suite:... LiveHandoffCheck <engine-url> <off-key>
 */
public class LiveHandoffCheck {
    static int pass = 0, fail = 0;

    static void chk(String what, boolean ok, String seen) {
        System.out.println("  " + (ok ? "ok  " + what : "FAIL " + what) + "   [" + seen + "]");
        if (ok) pass++; else fail++;
    }

    public static void main(String[] args) throws Exception {
        final String url = args[0];
        final String offKey = args[1];

        /* The task, left exactly as an engine dropping mid-answer leaves it. */
        TaskRecord t = new TaskRecord("live-handoff-1",
                "Explain how a lithium-ion battery works and why it degrades.");
        t.engine = "a";
        t.moveTo(TaskRecord.Phase.EXECUTING);
        t.plan("gather the chemistry");
        t.startStep("gather the chemistry");
        t.finishStep("gather the chemistry", true, "anode, cathode, electrolyte");
        t.plan("write the full explanation");
        t.startStep("write the full explanation");
        t.finishStep("write the full explanation", false, "engine A dropped mid-answer");
        t.recordCommand("pip install requests", 0, "Successfully installed");

        final String partial =
                "A lithium-ion cell stores energy by moving lithium ions between two "
              + "electrodes. During discharge, ions leave the anode, travel through the "
              + "electrolyte, and settle into the cathode while electrons take the longer "
              + "route through the external circuit -- that flow is the current you use.";

        final String carry = t.continuationPrompt(
                "Explain how a lithium-ion battery works and why it degrades. Cover the "
              + "anode, the cathode, the electrolyte and the degradation mechanisms.",
                partial, "c");

        System.out.println("== the string the next engine is sent ==");
        chk("it tells the new engine not to restart",
                carry.contains("CONTINUE THIS TASK, do not restart it"), "");
        chk("it names the failed step as failed, not done",
                carry.contains("- write the full explanation [failed]"), "");
        chk("it carries the partial verbatim", carry.contains(partial), "");

        System.out.println("\n== sending it through the real request path ==");
        final StringBuilder answer = new StringBuilder();
        final boolean[] cancel = {false};
        final boolean[] ok = {false};
        final String[] err = {null};
        final long[] firstTokenAt = {0};
        final long[] toolEvents = {0};
        long t0 = System.currentTimeMillis();

        EngineCore.chatStream(url, offKey, carry, "", cancel, new EngineCore.ChatListener() {
            @Override public void onThinking(String text) { toolEvents[0]++; }
            @Override public void onContent(String text) {
                if (firstTokenAt[0] == 0) firstTokenAt[0] = System.currentTimeMillis();
                answer.append(text);
            }
            @Override public void onDone(boolean good, String e) { ok[0] = good; err[0] = e; }
        }, EngineCore.StreamPolicy.standard());

        long total = System.currentTimeMillis() - t0;
        String text = answer.toString();

        System.out.println("  engine returned " + text.length() + " chars in "
                + (total / 1000) + "s (first token "
                + (firstTokenAt[0] == 0 ? "never" : ((firstTokenAt[0] - t0) / 1000) + "s") + ")");
        System.out.println("  answer opens: \"" + clip(text, 180) + "\"");

        System.out.println("\n== did it continue, or start over? ==");
        chk("the engine reached done:true", ok[0], String.valueOf(err[0]));
        chk("it produced a real answer", text.trim().length() > 200, text.length() + " chars");
        chk("the first token arrived", firstTokenAt[0] > 0,
                firstTokenAt[0] == 0 ? "never" : ((firstTokenAt[0] - t0) / 1000) + "s");

        /* The failure mode being guarded against: the new engine rewrites the
           opening that already exists. Compare the first 80 characters of each. */
        String pHead = partial.substring(0, Math.min(80, partial.length())).trim();
        String aHead = text.trim().substring(0, Math.min(80, text.trim().length()));
        chk("it does not rewrite the opening that already landed",
                !aHead.equalsIgnoreCase(pHead) && !text.trim().startsWith(pHead),
                "partial head \"" + clip(pHead, 60) + "\" vs answer head \""
                        + clip(aHead, 60) + "\"");

        /* It has to carry the task on: the unfinished business was degradation. */
        String low = text.toLowerCase();
        chk("it carries on into the part that was never reached",
                low.contains("degrad") || low.contains("cycle") || low.contains("dendrite")
                        || low.contains("sei") || low.contains("wear"),
                "degradation terms found: " + (low.contains("degrad") ? "degrad " : "")
                        + (low.contains("cycle") ? "cycle " : "")
                        + (low.contains("dendrite") ? "dendrite " : "")
                        + (low.contains("sei") ? "sei" : ""));

        System.out.println("\n" + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    static String clip(String s, int max) {
        if (s == null) return "";
        String one = s.replaceAll("\\s+", " ").trim();
        return one.length() <= max ? one : one.substring(0, max) + "...";
    }
}
