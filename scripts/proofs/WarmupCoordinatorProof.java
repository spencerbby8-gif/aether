import com.aether.app.WarmupCoordinator;

import java.util.Arrays;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/** Deterministic concurrency evidence; no Kaggle or live timing claim. */
public final class WarmupCoordinatorProof {
    private static int pass, fail;
    private static void check(String name, boolean ok, Object detail) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + name + "  [" + detail + "]");
        if (ok) pass++; else fail++;
    }

    public static void main(String[] args) throws Exception {
        Set<String> ready = ConcurrentHashMap.newKeySet();
        Map<String, AtomicInteger> wakes = new ConcurrentHashMap<>();
        Map<String, AtomicInteger> probes = new ConcurrentHashMap<>();
        WarmupCoordinator.Backend backend = new WarmupCoordinator.Backend() {
            @Override public String live(String slot) throws Exception {
                probes.computeIfAbsent(slot, k -> new AtomicInteger()).incrementAndGet();
                Thread.sleep(240);              // deterministic simulated network latency
                return ready.contains(slot) ? "https://ready.example/" + slot : null;
            }
            @Override public void wake(String slot) {
                wakes.computeIfAbsent(slot, k -> new AtomicInteger()).incrementAndGet();
                ready.add(slot);
            }
        };
        long elapsed = WarmupCoordinator.runParallel(Arrays.asList("a", "b", "c", "d"), backend, 3, 0);
        check("all four routes are prepared", ready.size() == 4, ready);
        check("every route is pushed exactly once", wakes.size() == 4
                && wakes.values().stream().allMatch(n -> n.get() == 1), wakes);
        check("preparation is concurrent, not four serial waits", elapsed < 900,
                elapsed + "ms fake-transport elapsed");
        check("each route reuses its first healthy probe", probes.values().stream().allMatch(n -> n.get() == 2), probes);

        ready.add("a");
        AtomicInteger duplicate = new AtomicInteger();
        WarmupCoordinator.Backend alreadyLive = new WarmupCoordinator.Backend() {
            @Override public String live(String slot) { return "https://ready.example/a"; }
            @Override public void wake(String slot) { duplicate.incrementAndGet(); }
        };
        String url = WarmupCoordinator.prepare("a", alreadyLive, 3, 0);
        check("a healthy route is reused without another push", duplicate.get() == 0
                && url.startsWith("https://"), url + "; pushes=" + duplicate.get());

        System.out.println("\nWARMUP COORDINATOR PROOF  " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }
}
