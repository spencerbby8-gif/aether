package com.aether.app;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** Pure-Java prepare/poll sequence shared by Android warm-up and JVM proofs. */
public final class WarmupCoordinator {
    public interface Backend {
        String live(String slot) throws Exception;
        void wake(String slot) throws Exception;
    }

    private WarmupCoordinator() { }

    public static String prepare(String slot, Backend backend, int maxPolls, long pollMs) throws Exception {
        String live = backend.live(slot);
        if (live != null) return live;           // reuse, never duplicate a healthy route
        backend.wake(slot);
        for (int i = 0; i < maxPolls; i++) {
            live = backend.live(slot);
            if (live != null) return live;
            if (pollMs > 0 && i + 1 < maxPolls) Thread.sleep(pollMs);
        }
        throw new Exception("Route did not become ready.");
    }

    public static long runParallel(List<String> slots, Backend backend, int maxPolls, long pollMs) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(slots.size());
        CountDownLatch done = new CountDownLatch(slots.size());
        long start = System.nanoTime();
        for (String slot : slots) pool.execute(() -> {
            try { prepare(slot, backend, maxPolls, pollMs); } catch (Exception ignored) { }
            done.countDown();
        });
        if (!done.await(10, TimeUnit.SECONDS)) throw new Exception("Warm-up proof timed out.");
        pool.shutdownNow();
        return (System.nanoTime() - start) / 1_000_000L;
    }
}
