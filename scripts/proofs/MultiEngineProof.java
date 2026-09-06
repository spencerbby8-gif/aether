import com.aether.app.EngineCore;
import com.aether.app.EngineRouter;

import java.util.ArrayList;
import java.util.List;

/**
 * Multi-engine proof: two real Kaggle engines live at the same time.
 *
 * This is the test that single-engine testing cannot do. With one engine you
 * cannot tell correct slot attribution from luck, and you cannot exercise
 * failover at all. Here both are live, both are attributed, both are chatted
 * with, AUTO has a real choice to make, and shut-down-all has two GPUs to
 * release.
 */
public final class MultiEngineProof {

    private static int passed = 0, failed = 0;
    private static String topic, offKey;
    private static EngineCore.Engine ea, eb;

    private static void check(String name, boolean ok, String detail) {
        if (ok) { passed++; System.out.println("  PASS  " + name + "  -- " + detail); }
        else { failed++; System.out.println("  FAIL  " + name + "  -- " + detail); }
    }

    public static void main(String[] args) throws Exception {
        topic = args[0];
        offKey = args[1];
        ea = new EngineCore.Engine("a", args[2], args[3], "qwen-3-8-27b-uncensored-chat");
        eb = new EngineCore.Engine("b", args[4], args[5], "qwen-3-8-27b-uncensored-chat");

        System.out.println("== 1. Discovery: attribute every live URL to the right slot");
        String ua = EngineCore.currentLinkFor(topic, "", "a", 3600, 25_000);
        String ub = EngineCore.currentLinkFor(topic, "", "b", 3600, 25_000);
        check("engine A discovered", ua != null, String.valueOf(ua));
        check("engine B discovered", ub != null, String.valueOf(ub));
        check("A and B got DIFFERENT urls", ua != null && !ua.equals(ub),
                "a=" + ua + " b=" + ub);

        System.out.println();
        System.out.println("== 2. Health: both must be LIVE, not merely booted");
        EngineCore.Health ha = EngineCore.health(ua, 25_000);
        EngineCore.Health hb = EngineCore.health(ub, 25_000);
        check("A /api/ps 200 with a loaded model", ha.isLive(),
                "HTTP " + ha.status + " " + ha.models);
        check("B /api/ps 200 with a loaded model", hb.isLive(),
                "HTTP " + hb.status + " " + hb.models);

        System.out.println();
        System.out.println("== 3. Routing with two engines genuinely live");
        List<EngineRouter.SlotState> both = new ArrayList<>();
        both.add(new EngineRouter.SlotState("a", ha.isLive(), ua, null, ha.status));
        both.add(new EngineRouter.SlotState("b", hb.isLive(), ub, null, hb.status));
        both.add(new EngineRouter.SlotState("c", false, null, "off", -1));

        EngineRouter.Decision auto = EngineRouter.route(EngineRouter.AUTO, both);
        check("AUTO picks A when A and B are both live", "a".equals(auto.slot), auto.toString());
        check("AUTO returns A's real url", ua.equals(auto.url), auto.url);
        check("manual pin on B selects B, not A",
                "b".equals(EngineRouter.route("b", both).slot), EngineRouter.route("b", both).toString());
        EngineRouter.Decision fo = EngineRouter.failoverFrom("a", both);
        check("failoverFrom(a) lands on B", "b".equals(fo.slot), fo.toString());

        System.out.println();
        System.out.println("== 4. Chat on EACH engine, to prove the url is the right one");
        String ra = chat(ua, "Reply with exactly: FROM ENGINE A");
        String rb = chat(ub, "Reply with exactly: FROM ENGINE B");
        System.out.println("      A said: " + ra);
        System.out.println("      B said: " + rb);
        check("A produced content", ra != null && !ra.isEmpty(), ra);
        check("B produced content", rb != null && !rb.isEmpty(), rb);
        check("neither returned the model-error stub",
                !"(model timeout/error)".equals(ra) && !"(model timeout/error)".equals(rb), "");
        check("A and B are different engines (different replies)",
                ra != null && rb != null && !ra.equals(rb), "");

        System.out.println();
        System.out.println("== 5. Failover actually happens when A dies");
        int offA = EngineCore.off(ua, offKey, 30_000);
        boolean downA = EngineCore.confirmedDown(ua, 6, 4_000, 20_000);
        check("A /off accepted", offA == 200, "HTTP " + offA);
        check("A confirmed terminated", downA, "/api/ps now " + EngineCore.health(ua, 20_000).status);

        List<EngineRouter.SlotState> aDown = new ArrayList<>();
        aDown.add(new EngineRouter.SlotState("a", false, null, "shut down", 502));
        aDown.add(new EngineRouter.SlotState("b", hb.isLive(), ub, null, hb.status));
        aDown.add(new EngineRouter.SlotState("c", false, null, "off", -1));
        EngineRouter.Decision after = EngineRouter.route(EngineRouter.AUTO, after_states(aDown));
        check("AUTO now routes to B", "b".equals(after.slot), after.toString());
        check("...and returns B's url", ub.equals(after.url), after.url);
        String rc = chat(ub, "Reply with exactly: STILL WORKING ON B");
        check("B still serves after A died", rc != null && !rc.isEmpty(), rc);

        System.out.println();
        System.out.println("== 6. Shut down ALL, and prove each one really went");
        int offB = EngineCore.off(ub, offKey, 30_000);
        boolean downB = EngineCore.confirmedDown(ub, 6, 4_000, 20_000);
        check("B /off accepted", offB == 200, "HTTP " + offB);
        check("B confirmed terminated", downB, "/api/ps now " + EngineCore.health(ub, 20_000).status);
        check("BOTH engines down", downA && downB, "");

        System.out.println();
        System.out.println("RESULT: " + passed + " passed, " + failed + " failed");
        System.exit(failed == 0 ? 0 : 1);
    }

    private static List<EngineRouter.SlotState> after_states(List<EngineRouter.SlotState> s) {
        return s;
    }

    private static String chat(String url, String prompt) {
        final StringBuilder out = new StringBuilder();
        EngineCore.chatStream(url, offKey, prompt, "", null, new EngineCore.ChatListener() {
            public void onThinking(String t) { }
            public void onContent(String t) { out.append(t); }
            public void onDone(boolean ok, String e) { }
        }, 300_000);
        return out.toString().trim();
    }
}
