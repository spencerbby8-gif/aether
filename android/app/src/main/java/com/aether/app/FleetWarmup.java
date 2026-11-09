package com.aether.app;

import android.content.Context;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Parallel, process-wide fleet preparation. No Activity owns the wake workers. */
public final class FleetWarmup {
    public interface Listener { void changed(); }

    private static final Object LOCK = new Object();
    private static final Map<String, String> READY = new HashMap<>();
    private static final List<Listener> LISTENERS = new ArrayList<>();
    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);
    private static ExecutorService workers;
    private static int total;
    private static int failed;
    private static boolean attempted;

    private FleetWarmup() { }

    /** Start once per process. Existing healthy routes are reused before any push. */
    public static void warmAll(Context context) {
        if (!AetherPrefs.warmOnLaunch(context) || RUNNING.get()) return;
        Credentials.Config cfg = Credentials.load(context);
        if (cfg == null || cfg.engines.isEmpty()) return;
        final String notebook;
        try { notebook = Credentials.notebookTemplate(context); }
        catch (Exception e) { return; }
        synchronized (LOCK) {
            total = cfg.engines.size(); failed = 0; attempted = true;
        }
        RUNNING.set(true);
        workers = Executors.newFixedThreadPool(Math.min(4, cfg.engines.size()), r -> {
            Thread t = new Thread(r, "aether-warmup"); t.setDaemon(true); return t;
        });
        for (EngineCore.Engine engine : cfg.engines) {
            workers.execute(() -> prepare(context, cfg, engine, notebook));
        }
        workers.shutdown();
    }

    private static void prepare(Context context, Credentials.Config cfg,
                                EngineCore.Engine engine, String notebook) {
        try {
            String live = WarmupCoordinator.prepare(engine.slot, new WarmupCoordinator.Backend() {
                @Override public String live(String slot) throws Exception {
                    return EngineCore.currentLinkFor(cfg.beaconTopic, cfg.beaconSecret,
                            slot, 20 * 60, 8_000);
                }
                @Override public void wake(String slot) throws Exception {
                    EngineCore.releasePrevious(engine, cfg.offKey, cfg.beaconTopic,
                            cfg.beaconSecret, 3600, 8_000);
                    EngineCore.kernelPush(engine, Credentials.renderNotebook(notebook, cfg, slot),
                            EngineCore.KERNEL_TITLE, true, 120_000);
                }
            }, 300, 2_000);
            markReady(engine.slot, live);
        } catch (Exception e) {
            markFailed();
        } finally {
            synchronized (LOCK) { LOCK.notifyAll(); }
            notifyListeners();
        }
    }

    private static void markReady(String slot, String url) {
        synchronized (LOCK) {
            READY.put(slot, url);
            LOCK.notifyAll();
        }
        notifyListeners();
    }

    private static void markFailed() {
        synchronized (LOCK) { failed++; LOCK.notifyAll(); }
        notifyListeners();
    }

    public static void addListener(Listener listener) {
        synchronized (LOCK) { if (!LISTENERS.contains(listener)) LISTENERS.add(listener); }
    }

    public static void removeListener(Listener listener) {
        synchronized (LOCK) { LISTENERS.remove(listener); }
    }

    private static void notifyListeners() {
        List<Listener> copy;
        synchronized (LOCK) { copy = new ArrayList<>(LISTENERS); }
        for (Listener listener : copy) listener.changed();
    }

    public static boolean isRunning() {
        if (!RUNNING.get()) return false;
        synchronized (LOCK) {
            if (READY.size() + failed >= total) {
                RUNNING.set(false);
                return false;
            }
        }
        return true;
    }

    public static void invalidate(String slot) {
        synchronized (LOCK) { READY.remove(slot); LOCK.notifyAll(); }
        notifyListeners();
    }

    public static int readyCount() { synchronized (LOCK) { return READY.size(); } }
    public static int totalCount() { synchronized (LOCK) { return total; } }
    public static boolean wasAttempted() { synchronized (LOCK) { return attempted; } }

    /** First ready route in the unchanged A→B→C→D order, or null. */
    public static EngineRouter.Decision readyDecision() {
        synchronized (LOCK) {
            for (String slot : EngineRouter.order()) {
                String url = READY.get(slot);
                if (url != null) return new EngineRouter.Decision(slot, url, "ready route", false);
            }
        }
        return null;
    }

    /** Chat waits on shared preparation; it never launches a duplicate wake. */
    public static EngineRouter.Decision awaitReady(long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        synchronized (LOCK) {
            while (System.currentTimeMillis() < deadline) {
                for (String slot : EngineRouter.order()) {
                    String url = READY.get(slot);
                    if (url != null) return new EngineRouter.Decision(slot, url, "ready route", false);
                }
                if (attempted && READY.size() + failed >= total) break;
                try { LOCK.wait(250); } catch (InterruptedException e) { Thread.currentThread().interrupt(); break; }
            }
        }
        return null;
    }

}
