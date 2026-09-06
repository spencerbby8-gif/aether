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
        int live = 0;
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
            System.out.println("  engine " + slot.toUpperCase() + ": " + reach + "  |  Kaggle says: " + ks);
        }
        System.out.println(live == 0 ? "ALL OFF - no engine is serving" : live + " engine(s) were still live");
    }
}
