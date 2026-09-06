import com.aether.app.EngineCore;
import java.io.FileInputStream;
import java.nio.file.*;
import java.util.*;

/**
 * Watches one real wake from the push to whatever happens next, printing a
 * timeline: Kaggle's kernel status, the tunnels the beacon announces, and
 * /api/ps. This reproduces "it says WAKING and never changes" and shows WHERE
 * the boot stops.
 *
 *   java -cp /tmp/ww:<json jar> WakeWatch <credentials.properties> <template> <slot> [minutes]
 */
public final class WakeWatch {

    public static void main(String[] args) throws Exception {
        Properties p = new Properties();
        try (FileInputStream in = new FileInputStream(args[0])) { p.load(in); }
        String topic = p.getProperty("beaconTopic");
        String secret = p.getProperty("beaconSecret", "");
        String slot = args[2].toLowerCase(Locale.ROOT);
        int minutes = args.length > 3 ? Integer.parseInt(args[3]) : 12;
        EngineCore.Engine e = new EngineCore.Engine(slot,
                p.getProperty("engine" + slot.toUpperCase(Locale.ROOT) + ".user"),
                p.getProperty("engine" + slot.toUpperCase(Locale.ROOT) + ".key"),
                p.getProperty("kernelSlug"));
        String template = new String(Files.readAllBytes(Paths.get(args[1])), "UTF-8");
        String rendered = template
                .replace("{{AETHER_OFF_KEY}}", p.getProperty("offKey"))
                .replace("{{AETHER_BEACON_TOKEN}}", topic)
                .replace("{{AETHER_BEACON_TOPIC}}", topic)
                .replace("{{AETHER_SLOT}}", slot);

        long t0 = System.currentTimeMillis();
        System.out.println("t+0s  pushing engine " + slot.toUpperCase(Locale.ROOT)
                + " (" + e.user + "/" + e.kernelSlug + "), notebook " + rendered.length() + " bytes");
        try {
            String r = EngineCore.kernelPush(e, rendered, EngineCore.KERNEL_TITLE, true, 120_000);
            System.out.println("      push accepted: " + r.replaceAll("\\s+", " ").trim());
        } catch (Exception ex) {
            System.out.println("      PUSH FAILED: " + ex.getMessage());
            return;
        }

        long deadline = t0 + minutes * 60_000L;
        String last = "";
        while (System.currentTimeMillis() < deadline) {
            Thread.sleep(20_000);
            long s = (System.currentTimeMillis() - t0) / 1000;

            String kg;
            try { kg = EngineCore.kernelStatus(e, 20_000); }
            catch (Exception ex) { kg = "status failed: " + ex.getMessage(); }

            String url = null;
            try {
                for (EngineCore.LiveLink l : EngineCore.liveLinks(topic, secret, 1800, 20_000)) {
                    if (slot.equals(l.slot)) { url = l.url; break; }
                }
            } catch (Exception ignored) { }

            String probe = "no tunnel announced";
            if (url != null) {
                EngineCore.Health h = EngineCore.health(url, 15_000);
                probe = "/api/ps HTTP " + h.status
                        + (h.models.isEmpty() ? " (no model yet)" : " models=" + h.models);
                if (h.status == 200 && !h.models.isEmpty()) {
                    System.out.println("t+" + s + "s  Kaggle=" + kg + "  " + probe);
                    System.out.println("\nRESULT: LIVE after " + s + "s. The engine boots.");
                    return;
                }
            }
            String line = "t+" + s + "s  Kaggle=" + kg + "  " + probe;
            if (!line.replaceAll("t\\+\\d+s", "").equals(last)) System.out.println(line);
            last = line.replaceAll("t\\+\\d+s", "");
        }
        System.out.println("\nRESULT: still not live after " + minutes + " minutes.");
        System.out.println("Last seen: Kaggle=" + last);
    }
}
