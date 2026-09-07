import com.aether.app.EngineCore;
import com.aether.app.EngineRouter;

import java.io.FileInputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Properties;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Failover, proven while an engine is genuinely dead.
 *
 * MultiEngineProof needs two engines live at once. That is the wrong test for
 * the failure users actually hit: a quick tunnel dies under a running kernel
 * and /api/ps starts answering 530 while Kaggle still says "running". This
 * proof runs the real discovery, health check, classifier and router against
 * whatever the beacon announces right now, and requires that a dead tunnel is
 * never reported LIVE and is never chosen by AUTO.
 *
 * It is only meaningful when at least one slot is dead, so it says so plainly
 * instead of quietly passing on a morning when all three happen to be up.
 *
 * Run:
 *   java -cp <out>:<json jar> FailoverProof android/credentials.properties
 */
public final class FailoverProof {

    private static int passed = 0, failed = 0;

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.out.println("usage: FailoverProof <credentials.properties>");
            System.exit(2);
        }
        Properties p = new Properties();
        try (FileInputStream in = new FileInputStream(args[0])) { p.load(in); }
        String topic = p.getProperty("beaconTopic");
        String secret = p.getProperty("beaconSecret", "");

        System.out.println("== live failover, real discovery and router ==\n");

        List<EngineRouter.SlotState> states = new ArrayList<>();
        List<String> dead = new ArrayList<>();
        List<String> live = new ArrayList<>();

        for (String slot : new String[] {"a", "b", "c"}) {
            String up = slot.toUpperCase(Locale.ROOT);
            List<String> urls;
            try {
                urls = EngineCore.urlsFor(topic, secret, slot, 3 * 3600, 20_000, 6);
            } catch (Exception e) {
                check(up + " discovery did not throw", false, String.valueOf(e));
                states.add(new EngineRouter.SlotState(slot, false, null,
                        "discovery failed", 0));
                continue;
            }

            /* Newest announcement first, exactly as the app sees it. A slot can
               have several running versions, each with its own tunnel. */
            EngineCore.Health best = null;
            String bestUrl = null;
            int lastStatus = 0;
            for (String u : urls) {
                EngineCore.Health h = EngineCore.health(u, 12_000);
                lastStatus = h.status;
                System.out.println("  " + up + "  " + mask(u)
                        + "  /api/ps " + h.status + "  models=" + h.models.size());
                if (h.isLive()) { best = h; bestUrl = u; break; }
            }

            boolean isLive = best != null;
            EngineCore.EngineState st = EngineCore.classify(up, lastStatus,
                    isLive ? best.models : new ArrayList<>(), bestUrl, null, null);
            System.out.println("  " + up + "  ->  " + st.phase + "  " + st.detail);

            if (isLive) live.add(slot); else dead.add(slot);

            /* The rule the UI promises: LIVE only after a real 200 with models.
               A 530 from a dead tunnel must never be dressed up as LIVE. */
            if (!isLive) {
                check(up + " (dead tunnel) is not reported LIVE",
                        st.phase != EngineCore.Phase.LIVE, st.phase + " " + st.detail);
            } else {
                check(up + " is reported LIVE with a model",
                        st.phase == EngineCore.Phase.LIVE && !st.models.isEmpty(),
                        st.phase + " models=" + st.models.size());
            }

            /* SlotState.slot is the router's canonical form: ORDER is
               {a,b,c} and find() compares exactly, so an uppercase "A" here
               would make AUTO report "no engine is live" with engines up. */
            states.add(new EngineRouter.SlotState(slot, isLive, bestUrl,
                    isLive ? null : ("health " + lastStatus), lastStatus));
        }

        System.out.println();
        if (live.isEmpty()) {
            System.out.println("No engine is live. Failover cannot be exercised.");
            System.out.println("Wake an engine first, then re-run.");
            System.out.println("\nFAILOVER PROOF  " + passed + " passed, " + failed
                    + " failed  (inconclusive: nothing live)");
            System.exit(2);
        }

        EngineRouter.Decision d = EngineRouter.route("AUTO", states);
        System.out.println("  AUTO chose " + d.slot + "  (" + d.reason + ")");
        check("AUTO picks an engine", d.ok(), d.reason);
        check("AUTO picked a slot that is actually live",
                d.ok() && live.contains(d.slot), d.slot + " live=" + live);
        check("AUTO never picked a dead tunnel",
                d.ok() && !dead.contains(d.slot), "dead=" + dead + " picked=" + d.slot);
        check("AUTO prefers A when A is healthy",
                !live.contains("a") || "a".equals(d.slot),
                "live=" + live + " picked=" + d.slot);
        /* failoverFrom() is the method that performs and reports a switch.
           AUTO choosing the first healthy slot is not a failover, so asserting
           failedOver on the AUTO decision was wrong. */
        EngineRouter.Decision f1 = EngineRouter.failoverFrom(d.slot, states);
        check("failover from " + d.slot.toUpperCase(Locale.ROOT) + " finds another live engine",
                f1.ok() && !f1.slot.equals(d.slot), "picked=" + f1.slot + " " + f1.reason);
        check("that switch is reported as a failover", f1.failedOver,
                "failedOver=" + f1.failedOver);
        if (!dead.isEmpty()) {
            String deadSlot = dead.get(0);
            EngineRouter.Decision f2 = EngineRouter.failoverFrom(deadSlot, states);
            check("failover from the dead slot " + deadSlot.toUpperCase(Locale.ROOT)
                        + " lands on a live one",
                    f2.ok() && live.contains(f2.slot), "picked=" + f2.slot);
        }

        /* A manual pin to the dead slot must refuse rather than silently serve
           something else -- the user asked for that engine specifically. */
        if (!dead.isEmpty()) {
            String pinned = dead.get(0);
            EngineRouter.Decision pd = EngineRouter.route(pinned, states);
            check("pinning the dead slot " + pinned.toUpperCase(Locale.ROOT)
                        + " refuses instead of lying",
                    !pd.ok(), "decision=" + pd.slot + " reason=" + pd.reason);
        }

        /* The chosen engine must actually answer, not merely look healthy. */
        System.out.println();
        System.out.println("  chatting through the routed engine " + d.slot + "...");
        final StringBuilder answer = new StringBuilder();
        final AtomicInteger deltas = new AtomicInteger();
        final AtomicInteger events = new AtomicInteger();
        final CountDownLatch latch = new CountDownLatch(1);
        final boolean[] ok = {false};
        final String[] err = {null};
        Thread t = new Thread(() -> EngineCore.chatStream(d.url,
                p.getProperty("offKey"), "Reply with the single word: routed", "",
                null, new EngineCore.ChatListener() {
                    @Override public void onThinking(String text) {
                        events.incrementAndGet();
                    }
                    @Override public void onContent(String text) {
                        deltas.incrementAndGet();
                        answer.append(text);
                    }
                    @Override public void onDone(boolean good, String e) {
                        ok[0] = good; err[0] = e; latch.countDown();
                    }
                }, EngineCore.StreamPolicy.standard()));
        t.setDaemon(true);
        t.start();
        /* Longer than the policy's 1260s read timeout would allow a stall, but
           a reasoning turn on a contended host has been measured over 240s and
           the earlier 600s latch mistook a slow live stream for a hang. */
        boolean done = false;
        try { done = latch.await(1500, TimeUnit.SECONDS); } catch (InterruptedException e) { }
        check("the routed engine answered", done && ok[0],
                "done=" + done + " error=" + err[0]
                        + " engineEvents=" + events.get());
        check("the answer came back as a stream, not one block",
                deltas.get() > 1, deltas.get() + " deltas");
        check("the answer is not empty",
                answer.toString().trim().length() > 0, "[" + answer + "]");
        System.out.println("  answer: " + answer.toString().trim().replaceAll("\\s+", " "));

        System.out.println();
        System.out.println("FAILOVER PROOF  " + passed + " passed, " + failed + " failed"
                + "   (live=" + live + " dead=" + dead + ")");
        if (failed > 0) System.exit(1);
    }

    private static String mask(String url) {
        return url.replaceAll("https?://", "").replaceAll("\\..*", ".***");
    }

    private static void check(String name, boolean ok, String detail) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + name + "   [" + detail + "]");
        if (ok) passed++; else failed++;
    }
}
