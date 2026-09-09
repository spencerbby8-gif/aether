import com.aether.app.EngineCore;

import java.io.FileInputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

/**
 * Live proof that a wake releases the engine it is replacing.
 *
 * Kaggle does not stop the previous kernel version when a new one is pushed and
 * offers no API to stop it (kaggle-api issue 388), so every wake used to leave
 * another GPU session running on the same account. Found live: engines B and C
 * each had two instances answering /api/ps 200 on different tunnels at once, and
 * the next push came back "Maximum batch GPU session count of 2 reached".
 *
 * This drives the real EngineCore.releasePrevious against the real beacon and
 * then checks, independently, that the instance stopped answering.
 *
 * Run: java -cp /tmp/lh:... ReleasePreviousCheck <slot>
 * Exits 2 when nothing was live, so "nothing to do" is never reported as a pass.
 */
public class ReleasePreviousCheck {
    static int pass = 0, fail = 0;

    static void chk(String what, boolean ok, String seen) {
        System.out.println("  " + (ok ? "ok  " + what : "FAIL " + what) + "   [" + seen + "]");
        if (ok) pass++; else fail++;
    }

    public static void main(String[] args) throws Exception {
        String slot = args.length > 0 ? args[0].toLowerCase() : "c";
        Properties p = new Properties();
        p.load(new FileInputStream("android/credentials.properties"));
        String topic = p.getProperty("beaconTopic");
        String secret = p.getProperty("beaconSecret");
        String offKey = p.getProperty("offKey");
        String slug = p.getProperty("kernelSlug");
        String up = slot.toUpperCase();

        EngineCore.Engine e = new EngineCore.Engine(slot,
                p.getProperty("engine" + up + ".user"),
                p.getProperty("engine" + up + ".key"), slug);

        System.out.println("== what is serving for engine " + up + " right now ==");
        List<String> live = new ArrayList<>();
        for (EngineCore.LiveLink l : EngineCore.liveLinks(topic, secret, 5400, 20_000)) {
            if (l.slot != null && !l.slot.equals(slot)) continue;   // another engine
            if (!EngineCore.health(l.url, 20_000).isLive()) continue;
            live.add(l.url);
            System.out.println("  live: " + l);
        }
        if (live.isEmpty()) {
            System.out.println("\nNOTHING TO RELEASE -- no live instance, so this run proves"
                    + " nothing. Wake the engine first.");
            System.exit(2);
        }
        chk(live.size() + " instance(s) of engine " + up + " answering /api/ps",
                !live.isEmpty(), live.size() + " live");

        System.out.println("\n== the real call the wake path now makes first ==");
        long t0 = System.currentTimeMillis();
        int released = EngineCore.releasePrevious(e, offKey, topic, secret, 5400, 20_000);
        long ms = System.currentTimeMillis() - t0;
        System.out.println("  releasePrevious -> " + released + " in " + ms + "ms");
        chk("it stood down every instance it found", released == live.size(),
                released + " of " + live.size());

        System.out.println("\n== verified independently, not from the return value ==");
        /* /off returning 200 only proves the request was accepted. The claim is
           that the engine is gone, so probe it again. The kernel gives the
           supervisor a moment to notice the halt flag. */
        Thread.sleep(10_000);
        int stillUp = 0;
        for (String url : live) {
            boolean up2 = EngineCore.health(url, 20_000).isLive();
            System.out.println("  " + (up2 ? "STILL LIVE " : "dead       ") + url);
            if (up2) stillUp++;
        }
        chk("no instance still answers /api/ps", stillUp == 0, stillUp + " still up");

        System.out.println("\n" + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }
}
