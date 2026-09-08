import com.aether.app.EngineCore;
import java.io.FileInputStream;
import java.util.Properties;

/** Confirm every engine is really off: no live tunnel, and Kaggle's own status. */
public final class AllOff {
    public static void main(String[] a) throws Exception {
        Properties p = new Properties();
        try (FileInputStream in = new FileInputStream(a[0])) { p.load(in); }
        String topic = p.getProperty("beaconTopic"), secret = p.getProperty("beaconSecret");
        String offKey = p.getProperty("offKey"), slug = p.getProperty("kernelSlug");
        int live = 0;          // tunnels answering right now
        int sessions = 0;      // Kaggle sessions still held, tunnel or not
        for (String slot : new String[] {"a", "b", "c"}) {
            EngineCore.Engine e = new EngineCore.Engine(slot,
                    p.getProperty("engine" + slot.toUpperCase() + ".user"),
                    p.getProperty("engine" + slot.toUpperCase() + ".key"), slug);
            String url = null;
            try { url = EngineCore.currentLinkFor(topic, secret, slot, 3600, 25_000); }
            catch (Exception ex) { System.out.println("  " + slot + " beacon: " + ex.getMessage()); }
            String reach = "no live tunnel";
            if (url != null) {
                EngineCore.Health h = EngineCore.health(url, 20_000);
                reach = "/api/ps " + h.status + " models=" + h.models;
                if (h.isLive()) {
                    live++;
                    System.out.println("  " + slot.toUpperCase() + " STILL LIVE -> shutting down");
                    EngineCore.off(url, offKey, 30_000);
                    System.out.println("  " + slot.toUpperCase() + " confirmed down: "
                            + EngineCore.confirmedDown(url, 8, 5_000, 20_000));
                }
            }
            String ks;
            try { ks = EngineCore.kernelStatus(e, 20_000); } catch (Exception ex) { ks = "status failed"; }
            if (ks != null && ks.contains("running")) sessions++;
            System.out.println("  engine " + slot.toUpperCase() + ": " + reach + "  |  Kaggle says: " + ks);
        }
        /* A dead tunnel is not a stopped engine. Kaggle keeps the SESSION, and
           the GPU, after the process is gone -- measured, kernels/status still
           said "running" 50 minutes after /off returned 200, and the next push
           was refused with "Maximum batch GPU session count of 2 reached". So a
           verdict built from tunnel reachability alone reports "all off" while
           the account is still holding every session it has. */
        if (live == 0 && sessions == 0) {
            System.out.println("ALL OFF - nothing serving and no Kaggle session held");
        } else {
            System.out.println((live > 0 ? live + " engine(s) still serving"
                    : "nothing serving") + "; " + sessions
                    + " Kaggle session(s) still held - NOT off");
        }
    }
}
