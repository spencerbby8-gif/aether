package com.aether.app;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The engine console, and the app's entry point. There is no Aether server in
 * this build -- the phone talks to Kaggle and to the engines directly.
 *
 * ROUTING. AUTO or a manual A / B / C pin. Selection and LIVE state stay
 * separate (see EngineRouter): pinning B never makes the console pretend B is
 * up, and AUTO is free to move when its engine dies.
 *
 * WHAT "LIVE" MEANS. Not "the kernel is running" -- a kernel reports running from
 * the moment Kaggle starts it, minutes before the model is warm. LIVE requires a
 * beacon URL attributed to this slot AND /api/ps answering 200 with a non-empty
 * models[]. That is the only state in which Open is enabled, because it is the
 * only state in which a chat can actually be answered.
 *
 * THREADING. pollOnce() runs on a background thread and render() on the UI
 * thread, so every map they share is a ConcurrentHashMap. Plain HashMaps here
 * were a real defect: concurrent put/resize from two threads can lose entries or
 * spin, and the symptom would be an engine row that never updates -- which looks
 * exactly like an engine that is down.
 *
 * POLLING. One loop, guarded by a generation counter so that a fast
 * onPause/onResume cycle cannot leave two loops running and double the API
 * calls. One beacon fetch per cycle is shared by all three slots, and Kaggle is
 * only consulted for engines with no live URL -- so a live engine costs one
 * cheap probe and no API call at all.
 */
public class EnginesActivity extends AppCompatActivity {

    private static final int POLL_MS = 15_000;
    private static final int BEACON_LOOKBACK_S = 3 * 3600;
    private static final String PREFS = "aether_console";

    private Credentials.Config cfg;
    private LinearLayout rows;
    private TextView errorView;
    private TextView modeView;
    private Button openAuto;
    private Button offAll;

    private final Map<String, View> rowViews = new ConcurrentHashMap<>();
    private final Map<String, String> liveUrls = new ConcurrentHashMap<>();
    private final Map<String, String> states = new ConcurrentHashMap<>();
    private final Map<String, Integer> healthCodes = new ConcurrentHashMap<>();

    private final ExecutorService bg = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final AtomicInteger generation = new AtomicInteger();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_engines);

        rows = findViewById(R.id.rows);
        errorView = findViewById(R.id.error);
        modeView = findViewById(R.id.mode);
        openAuto = findViewById(R.id.open_auto);
        offAll = findViewById(R.id.off_all);

        cfg = Credentials.load(this);
        if (cfg == null || cfg.engines.isEmpty()) {
            errorView.setText("This APK was built without engine credentials.\n\n"
                    + "Fill in android/credentials.properties, then run "
                    + "scripts/bake-credentials.sh and scripts/build-apk.sh.");
            openAuto.setEnabled(false);
            offAll.setEnabled(false);
            return;
        }

        LayoutInflater inflater = LayoutInflater.from(this);
        for (EngineCore.Engine e : cfg.engines) {
            View row = inflater.inflate(R.layout.engine_row, rows, false);
            ((TextView) row.findViewById(R.id.name)).setText("Engine " + e.slot.toUpperCase());
            ((TextView) row.findViewById(R.id.status)).setText("checking…");

            Button wake = row.findViewById(R.id.wake);
            Button open = row.findViewById(R.id.open);
            Button off = row.findViewById(R.id.off);
            open.setEnabled(false);
            off.setEnabled(false);

            final String slot = e.slot;
            wake.setOnClickListener(v -> wake(e, wake));
            open.setOnClickListener(v -> openEngine(slot));
            off.setOnClickListener(v -> shutDown(e, off));
            row.findViewById(R.id.pin).setOnClickListener(v -> setMode(slot));

            rows.addView(row);
            rowViews.put(e.slot, row);
            states.put(e.slot, "unknown");
        }

        openAuto.setOnClickListener(v -> openRouted());
        offAll.setOnClickListener(v -> shutDownAll());
        findViewById(R.id.auto).setOnClickListener(v -> setMode(EngineRouter.AUTO));

        ((TextView) findViewById(R.id.footnote)).setText(
                "Kernel: " + cfg.kernelSlug + "\nBeacon: ntfy.sh/" + cfg.beaconTopic
                + "\n\nLIVE means /api/ps returned 200 with a loaded model. \"Booting\" means "
                + "Kaggle started the kernel but the weights are not warm yet, which takes "
                + "several minutes.\n\nOpen (auto) follows the routing choice above. Shut down "
                + "all releases every GPU at once, and only reports OFF once each engine has "
                + "been confirmed gone.");

        renderMode();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (cfg == null || cfg.engines.isEmpty()) return;
        int gen = generation.incrementAndGet();
        bg.execute(() -> pollLoop(gen));
    }

    @Override
    protected void onPause() {
        super.onPause();
        generation.incrementAndGet();   // retires any running loop
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        generation.incrementAndGet();
        bg.shutdownNow();
    }

    // -------------------------------------------------------------- routing

    private String mode() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString("mode", EngineRouter.AUTO);
    }

    private void setMode(String m) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("mode", m).apply();
        renderMode();
        render();
    }

    private void renderMode() {
        String m = mode();
        modeView.setText(EngineRouter.AUTO.equals(m)
                ? "Routing: AUTO — first healthy in A→B→C, fails over"
                : "Routing: pinned to " + m.toUpperCase() + " — will not fail over");
    }

    // -------------------------------------------------------------- polling

    private void pollLoop(int gen) {
        while (generation.get() == gen) {
            try {
                pollOnce();
                ui.post(this::render);
            } catch (Exception ex) {
                final String msg = ex.getMessage();
                ui.post(() -> errorView.setText("Poll failed: " + msg));
            }
            try {
                Thread.sleep(POLL_MS);
            } catch (InterruptedException ie) {
                return;
            }
        }
    }

    private void pollOnce() {
        /* One beacon fetch shared by every slot. */
        Map<String, String> links = new ConcurrentHashMap<>();
        try {
            for (EngineCore.LiveLink l : EngineCore.liveLinks(
                    cfg.beaconTopic, cfg.beaconSecret, BEACON_LOOKBACK_S, 20_000)) {
                if (l.slot == null || cfg.bySlot(l.slot) == null) continue;
                if (!links.containsKey(l.slot)) links.put(l.slot, l.url);   // newest first
            }
        } catch (Exception ignored) {
            /* A beacon outage must not blank the console; Kaggle status still works. */
        }

        for (EngineCore.Engine e : cfg.engines) {
            String url = links.get(e.slot);
            if (url != null) {
                EngineCore.Health h = EngineCore.health(url, 15_000);
                healthCodes.put(e.slot, h.status);
                if (h.isLive()) {
                    liveUrls.put(e.slot, url);
                    states.put(e.slot, "LIVE — " + String.join(", ", h.models));
                    continue;
                }
                /* Announced but not serving. A dead tunnel answers 530, and a
                   kernel answers 200 with an empty models[] while it warms up.
                   Either way it must not be offered as LIVE. */
                liveUrls.remove(e.slot);
                states.put(e.slot, h.status == 200
                        ? "booting — model not loaded yet"
                        : "announced but unreachable (HTTP " + h.status + ")");
                continue;
            }
            liveUrls.remove(e.slot);
            states.put(e.slot, kernelState(e));
        }
    }

    private String kernelState(EngineCore.Engine e) {
        try {
            String s = EngineCore.kernelStatus(e, 20_000);
            switch (s == null ? "" : s) {
                case "running": return "booting — kernel running, model not warm";
                case "queued":  return "queued for a GPU";
                case "error":   return "off";     // Kaggle's resting state, not a failure
                default:        return s.isEmpty() ? "unknown" : s;
            }
        } catch (EngineCore.EngineException ex) {
            return "status failed (HTTP " + ex.status + ")";
        }
    }

    private List<EngineRouter.SlotState> slotStates() {
        List<EngineRouter.SlotState> out = new ArrayList<>();
        for (EngineCore.Engine e : cfg.engines) {
            String st = states.get(e.slot);
            boolean live = st != null && st.startsWith("LIVE");
            Integer hc = healthCodes.get(e.slot);
            out.add(new EngineRouter.SlotState(e.slot, live, liveUrls.get(e.slot),
                    live ? null : (st == null ? "unknown" : st), hc == null ? -1 : hc));
        }
        return out;
    }

    private void render() {
        errorView.setText("");
        EngineRouter.Decision d = EngineRouter.route(mode(), slotStates());
        for (Map.Entry<String, View> en : rowViews.entrySet()) {
            String slot = en.getKey();
            View row = en.getValue();
            String state = states.get(slot);
            boolean live = state != null && state.startsWith("LIVE");
            boolean busy = state != null && (state.startsWith("booting") || state.startsWith("queued"));

            TextView status = row.findViewById(R.id.status);
            status.setText(state == null ? "unknown" : state);
            status.setTextColor(getColor(live ? R.color.aether_ok
                    : (busy ? R.color.aether_warn : R.color.aether_muted)));

            TextView badge = row.findViewById(R.id.badge);
            badge.setText(slot.equals(d.slot) ? getString(R.string.active) : "");

            Button wake = row.findViewById(R.id.wake);
            Button open = row.findViewById(R.id.open);
            Button off = row.findViewById(R.id.off);
            wake.setEnabled(!busy);
            wake.setText(busy ? "Waking…" : getString(R.string.wake));
            open.setEnabled(live);
            off.setEnabled(live || busy);
        }
        openAuto.setEnabled(d.ok());
        openAuto.setText(d.ok()
                ? "Open " + d.slot.toUpperCase() + (d.failedOver ? " (failed over)" : "")
                : "Nothing live to open");
    }

    // -------------------------------------------------------------- actions

    private void wake(EngineCore.Engine e, Button wake) {
        wake.setEnabled(false);
        wake.setText("Waking…");
        states.put(e.slot, "queued for a GPU");
        render();
        bg.execute(() -> {
            String result;
            try {
                String notebook = Credentials.renderNotebook(
                        Credentials.notebookTemplate(this), cfg, e.slot);
                EngineCore.kernelPush(e, notebook, EngineCore.KERNEL_TITLE, true, 120_000);
                result = "queued for a GPU";
            } catch (Exception ex) {
                result = "wake failed: " + ex.getMessage();
            }
            states.put(e.slot, result);
            final String r = result;
            ui.post(() -> {
                if (r.startsWith("wake failed")) errorView.setText(r);
                render();
            });
        });
    }

    /**
     * Shut one engine down. Reports OFF only once it is confirmed gone -- a 200
     * from /off means the request was accepted, not that the GPU was released.
     * Measured: Kaggle's own kernel status still reads "running" for a while
     * afterwards.
     */
    private void shutDown(EngineCore.Engine e, Button off) {
        off.setEnabled(false);
        states.put(e.slot, "shutting down…");
        ui.post(this::render);
        bg.execute(() -> {
            states.put(e.slot, shutOne(e.slot));
            ui.post(this::render);
        });
    }

    /**
     * Shut down EVERY live engine.
     *
     * This is the power control the app actually needs: leaving one engine up
     * keeps burning quota while the UI says everything is off. Each engine is
     * confirmed individually, and the summary names any that did not go down
     * rather than reporting a clean sweep it did not verify.
     */
    private void shutDownAll() {
        offAll.setEnabled(false);
        offAll.setText("Shutting down…");
        bg.execute(() -> {
            List<String> targets = new ArrayList<>();
            for (EngineCore.Engine e : cfg.engines) {
                if (liveUrls.containsKey(e.slot)) targets.add(e.slot);
            }
            if (targets.isEmpty()) {
                ui.post(() -> {
                    offAll.setText("Shut down all");
                    offAll.setEnabled(true);
                    errorView.setText("Nothing to shut down — no engine is live.");
                });
                return;
            }
            List<String> failed = new ArrayList<>();
            for (String slot : targets) {
                ui.post(() -> states.put(slot, "shutting down…"));
                String r = shutOne(slot);
                states.put(slot, r);
                if (!r.startsWith("off")) failed.add(slot.toUpperCase() + ": " + r);
                ui.post(this::render);
            }
            final String summary = failed.isEmpty()
                    ? targets.size() + " engine(s) confirmed terminated."
                    : "Shut down incomplete — " + String.join("; ", failed);
            ui.post(() -> {
                offAll.setText("Shut down all");
                offAll.setEnabled(true);
                errorView.setTextColor(getColor(failed.isEmpty()
                        ? R.color.aether_ok : R.color.aether_error));
                errorView.setText(summary);
            });
        });
    }

    /** Shared by single and bulk shutdown. Returns a state string. */
    private String shutOne(String slot) {
        String url = liveUrls.get(slot);
        if (url == null) return "no live URL to shut down";
        try {
            int code = EngineCore.off(url, cfg.offKey, 30_000);
            if (code != 200) return "shutdown HTTP " + code;
            if (EngineCore.confirmedDown(url, 6, 4_000, 20_000)) {
                liveUrls.remove(slot);
                return "off — confirmed terminated";
            }
            return "shutdown sent but the engine is STILL LIVE";
        } catch (Exception ex) {
            return "shutdown failed: " + ex.getMessage();
        }
    }

    /**
     * Open an engine, re-discovering its URL first.
     *
     * The cached URL can be minutes old and a Cloudflare quick tunnel changes on
     * every boot, so a stale one loads a 530 error page. currentLinkFor() walks
     * the beacon newest-first and returns the first URL that is genuinely live,
     * which is what discards the stale one.
     */
    private void openEngine(String slot) {
        offAll.setEnabled(false);
        bg.execute(() -> {
            String fresh = null;
            try {
                fresh = EngineCore.currentLinkFor(
                        cfg.beaconTopic, cfg.beaconSecret, slot, BEACON_LOOKBACK_S, 20_000);
            } catch (Exception ignored) { }
            final String url = fresh != null ? fresh : liveUrls.get(slot);
            ui.post(() -> {
                offAll.setEnabled(true);
                if (url == null) {
                    errorView.setText("Engine " + slot.toUpperCase()
                            + " is no longer reachable. Wake it again.");
                    return;
                }
                launch(slot, url);
            });
        });
    }

    /** Open whichever engine the current routing choice selects. */
    private void openRouted() {
        EngineRouter.Decision d = EngineRouter.route(mode(), slotStates());
        if (!d.ok()) return;
        openEngine(d.slot);
    }

    private void launch(String slot, String url) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString("activeSlot", slot)
                .putString("activeUrl", url)
                .apply();
        startActivity(new Intent(this, MainActivity.class));
    }
}
