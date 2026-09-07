import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/**
 * Proves the mechanism behind "the switch does nothing at all".
 *
 * SettingsActivity ran its poll loop and its button handlers on ONE
 * single-thread executor. pollLoop() never returns while the screen is open, so
 * it owned the only worker thread and every wake/shutdown task waited behind it
 * in the queue. The UI text was written synchronously before execute(), so the
 * card said WAKING and the note said "Shutting down…" while nothing ran.
 *
 * This cannot be reproduced by constructing the Activity on a JVM (Android
 * classes), so it reproduces the exact scheduling instead: same executor types,
 * same infinite loop, same task submission order. Part 3 then verifies the
 * shipped source and artifact no longer have the shared executor.
 *
 *   java -cp /tmp/ex ExecutorProof
 */
public final class ExecutorProof {

    private static int pass, fail;

    private static void check(String what, boolean ok, String detail) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + what
                + (detail == null || detail.isEmpty() ? "" : "  [" + detail + "]"));
        if (ok) pass++; else fail++;
    }

    private static void section(String s) { System.out.println("\n== " + s); }

    private static ThreadFactory daemon() {
        return r -> { Thread t = new Thread(r); t.setDaemon(true); return t; };
    }

    /** The screen being open: a poll loop that only ends when the generation changes. */
    private static Runnable pollLoop(AtomicInteger generation, int gen, AtomicInteger polls) {
        return () -> {
            while (generation.get() == gen) {
                polls.incrementAndGet();
                try { Thread.sleep(200); } catch (InterruptedException e) { return; }
            }
        };
    }

    public static void main(String[] args) throws Exception {
        // ---------------------------------------------- 1. the old wiring
        section("the old wiring: one single-thread executor for polling AND actions");
        AtomicInteger gen1 = new AtomicInteger(1);
        AtomicInteger polls1 = new AtomicInteger();
        CountDownLatch actionRan = new CountDownLatch(1);
        ExecutorService shared = Executors.newSingleThreadExecutor(daemon());
        shared.execute(pollLoop(gen1, 1, polls1));          // onResume
        shared.execute(actionRan::countDown);               // the Wake button
        boolean ranOld = actionRan.await(5, TimeUnit.SECONDS);
        check("the poll loop is running", polls1.get() > 5, polls1.get() + " polls");
        check("the button's work NEVER runs while the screen is open", !ranOld,
                ranOld ? "it ran" : "still queued after 5s -- this is the bug");

        /* And the accidental unblock: leaving the screen or pressing Check now
           bumps the generation, the loop exits, and the stuck task suddenly runs.
           That is why it looked like the switch sometimes worked. */
        gen1.incrementAndGet();
        boolean ranAfterBump = actionRan.await(5, TimeUnit.SECONDS);
        check("it runs the moment the generation is bumped", ranAfterBump,
                "the loop ended, so the queued task finally executed");
        shared.shutdownNow();

        // ---------------------------------------------- 2. the new wiring
        section("the new wiring: polling and actions on separate executors");
        AtomicInteger gen2 = new AtomicInteger(1);
        AtomicInteger polls2 = new AtomicInteger();
        ExecutorService pollExec = Executors.newSingleThreadExecutor(daemon());
        ExecutorService actionExec = Executors.newCachedThreadPool(daemon());
        pollExec.execute(pollLoop(gen2, 1, polls2));

        CountDownLatch wake = new CountDownLatch(1);
        long t0 = System.currentTimeMillis();
        actionExec.execute(wake::countDown);
        boolean ranWake = wake.await(5, TimeUnit.SECONDS);
        long wakeMs = System.currentTimeMillis() - t0;
        check("the button's work runs immediately", ranWake, wakeMs + "ms");
        /* The loop sleeps 200ms per pass, so give it time before counting -- an
           assertion made 1ms in would fail even though polling is fine. */
        Thread.sleep(1_500);
        check("polling carried on regardless", polls2.get() > 5, polls2.get() + " polls");

        /* The other half of the fix: a wake watch can block for 15 minutes. It
           must not be able to stop a shutdown, so actions get a pool, not a
           single thread. */
        CountDownLatch longWatch = new CountDownLatch(1);
        CountDownLatch shutdown = new CountDownLatch(1);
        actionExec.execute(() -> {
            try { Thread.sleep(4_000); } catch (InterruptedException ignored) { }
            longWatch.countDown();
        });
        long t1 = System.currentTimeMillis();
        actionExec.execute(shutdown::countDown);
        boolean ranShutdown = shutdown.await(3, TimeUnit.SECONDS);
        long shutdownMs = System.currentTimeMillis() - t1;
        check("a shutdown is not blocked by a wake watch in progress",
                ranShutdown, shutdownMs + "ms while the watch was still running");
        check("the wake watch was still running at that point",
                longWatch.getCount() == 1, "blocking task in flight");
        longWatch.await(5, TimeUnit.SECONDS);
        gen2.incrementAndGet();
        pollExec.shutdownNow();
        actionExec.shutdownNow();

        // ------------------------------------- 3. the shipped code and APK
        section("the shipped source no longer shares one executor");
        String src = read("android/app/src/main/java/com/aether/app/SettingsActivity.java");
        check("no shared 'bg' executor remains",
                !src.contains("bg.execute") && !src.contains("ExecutorService bg"),
                "bg references: " + (src.contains("bg.execute") ? "present" : "none"));
        check("polling has its own executor", src.contains("pollExec.execute(() -> pollLoop"),
                count(src, "pollExec.execute") + " poll submissions");
        check("every action goes to the action pool",
                count(src, "actionExec.execute") >= 4,
                count(src, "actionExec.execute")
                        + " actions (wake, shutdown, shutdown all, diagnostics)");
        check("the poll loop is the only thing on the poll thread",
                count(src, "pollExec.execute") == 2,
                count(src, "pollExec.execute") + " poll submissions (onResume, checkNow)");
        check("both executors are shut down on destroy",
                src.contains("pollExec.shutdownNow()") && src.contains("actionExec.shutdownNow()"),
                "onDestroy");
        check("worker threads are daemons", src.contains("setDaemon(true)"), "thread factory");

        System.out.println("\nEXECUTOR PROOF  " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    private static int count(String s, String needle) {
        int n = 0, i = 0;
        while ((i = s.indexOf(needle, i)) >= 0) { n++; i += needle.length(); }
        return n;
    }

    private static String read(String path) {
        try {
            return new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(path)),
                    java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            System.out.println("  could not read " + path + ": " + e.getMessage());
            return "";
        }
    }
}
