package com.aether.app;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Engine selection, status, wake and shutdown live here -- deliberately NOT on
 * the main chat screen, which stays focused on conversation.
 *
 * ROUTING. AUTO or a manual A / B / C pin, chosen as a row. Selection and LIVE
 * state stay separate (EngineRouter): pinning B shows B as off when it is off,
 * and AUTO is free to move.
 *
 * WHAT "LIVE" MEANS. A beacon URL attributed to the slot AND /api/ps 200 with a
 * non-empty models[]. "Booting" is shown while the kernel runs but the model is
 * not warm, so the user is never told an engine is ready when it cannot answer.
 *
 * POLLING. One loop guarded by a generation counter; one beacon fetch per cycle
 * shared by all three slots; Kaggle consulted only for engines with no live URL.
 *
 * SHUT-DOWN asks before it acts, reports the outcome in the note under the
 * cards, and confirms each engine individually via confirmedDown() before it is
 * called OFF -- rather than reporting a sweep it did not verify. The button is
 * enabled in every state: when there is no tunnel URL to reach, the result line
 * says so instead of the control appearing dead.
 */
public class SettingsActivity extends AppCompatActivity {

    private static final int POLL_MS = 15_000;
    /** While a wake or a shutdown is in flight: the user is watching a change. */
    private static final int FAST_POLL_MS = 4_000;
    private static final int BEACON_LOOKBACK_S = 3 * 3600;
    private static final long WAKE_WATCH_MS = 15 * 60_000L;

    private Credentials.Config cfg;
    private LinearLayout routingRows;
    private LinearLayout engineRows;
    private TextView note;
    private Button offAll;

    private final Map<String, View> rowViews = new ConcurrentHashMap<>();
    private final Map<String, String> liveUrls = new ConcurrentHashMap<>();
    private final Map<String, String> states = new ConcurrentHashMap<>();

    private final ExecutorService bg = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final AtomicInteger generation = new AtomicInteger();
    /** How many wake/shutdown operations are in flight; drives the poll rate. */
    private final AtomicInteger transitions = new AtomicInteger();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);

        routingRows = findViewById(R.id.routing_rows);
        engineRows = findViewById(R.id.engine_rows);
        note = findViewById(R.id.settings_note);
        offAll = findViewById(R.id.off_all);

        findViewById(R.id.back_btn).setOnClickListener(v -> finish());
        findViewById(R.id.check_now).setOnClickListener(v -> checkNow());

        cfg = Credentials.load(this);
        if (cfg == null || cfg.engines.isEmpty()) {
            note.setText("No engine credentials are baked into this build.");
            return;
        }

        buildRoutingRows();
        buildEngineRows();
        offAll.setOnClickListener(v -> shutDownAll());

        /* Paint the cards at once. Waiting for the first poll -- a beacon fetch
           plus a health check per engine -- left every button in its initial
           state for up to a minute, which reads as a screen that does nothing. */
        render();

        note.setText("LIVE means /api/ps returned 200 with a loaded model. \"Booting\" "
                + "means Kaggle started the kernel but the weights are not warm yet, which "
                + "takes several minutes.\n\nShutting an engine down is what releases the GPU "
                + "quota. Shut down all releases every engine at once and only reports OFF once "
                + "each has been confirmed gone.");
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (cfg == null) return;
        int gen = generation.incrementAndGet();
        bg.execute(() -> pollLoop(gen));
    }

    @Override
    protected void onPause() {
        super.onPause();
        generation.incrementAndGet();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        generation.incrementAndGet();
        bg.shutdownNow();
    }

    /** Force a poll immediately instead of waiting for the next tick. */
    private void checkNow() {
        announce("Checking every engine now…");
        states.replaceAll((k, v) -> v != null && v.startsWith("LIVE") ? v : "checking…");
        render();
        int gen = generation.incrementAndGet();
        bg.execute(() -> pollLoop(gen));
    }

    // ------------------------------------------------------------- routing

    private String mode() {
        return getSharedPreferences("aether_console", MODE_PRIVATE)
                .getString("mode", EngineRouter.AUTO);
    }

    /**
     * Pinning an engine is a routing choice, and on its own it does not turn
     * anything on -- which is exactly the gap that made the switch look broken.
     * So when the chosen engine is not live, say so at once and offer to wake
     * it, instead of leaving the user staring at a selection that changed
     * nothing they can see.
     */
    private void chooseMode(final String o) {
        setMode(o);
        if (EngineRouter.AUTO.equals(o)) {
            announce("AUTO selected -- the first healthy engine answers, and a failed "
                    + "engine fails over A\u2192B\u2192C.");
            return;
        }
        final String up = o.toUpperCase(Locale.ROOT);
        String st = states.get(o);
        if (st != null && st.startsWith("LIVE")) {
            announce("Engine " + up + " pinned. It is live, so only it will answer.");
            return;
        }
        final EngineCore.Engine e = cfg == null ? null : cfg.bySlot(o);
        new AlertDialog.Builder(this)
                .setTitle("Engine " + up + " is not live")
                .setMessage("Pinned, so only engine " + up + " will be used. It is currently: "
                        + (st == null ? "unknown" : st)
                        + "\n\nBooting a kernel takes several minutes.")
                .setNegativeButton(R.string.just_pin, null)
                .setPositiveButton(R.string.pin_and_wake, (d, w) -> {
                    if (e != null) wake(e, null);
                })
                .show();
    }

    private void setMode(String m) {
        getSharedPreferences("aether_console", MODE_PRIVATE).edit().putString("mode", m).apply();
        buildRoutingRows();
    }

    private void buildRoutingRows() {
        routingRows.removeAllViews();
        String[] opts = {EngineRouter.AUTO, "a", "b", "c"};
        for (String o : opts) {
            boolean selected = EngineRouter.canonical(mode()).equals(o);
            TextView row = new TextView(this);
            row.setText(EngineRouter.AUTO.equals(o)
                    ? (selected ? "●  " : "○  ") + "AUTO — first healthy, fails over A→B→C"
                    : (selected ? "●  " : "○  ") + "Engine " + o.toUpperCase() + " — pinned, no failover");
            row.setTextColor(getColor(selected ? R.color.aether_fg : R.color.aether_muted));
            row.setTextSize(14);
            row.setBackgroundResource(R.drawable.bg_card);
            row.setPadding(Ui.dp(this, 14), Ui.dp(this, 12), Ui.dp(this, 14), Ui.dp(this, 12));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.topMargin = Ui.dp(this, 6);
            row.setLayoutParams(lp);
            row.setOnClickListener(v -> chooseMode(o));
            routingRows.addView(row);
        }
    }

    // ------------------------------------------------------------- engines

    private void buildEngineRows() {
        engineRows.removeAllViews();
        rowViews.clear();
        for (EngineCore.Engine e : cfg.engines) {
            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setBackgroundResource(R.drawable.bg_card);
            card.setPadding(Ui.dp(this, 14), Ui.dp(this, 12), Ui.dp(this, 14), Ui.dp(this, 12));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.topMargin = Ui.dp(this, 8);
            card.setLayoutParams(lp);

            LinearLayout head = new LinearLayout(this);
            head.setOrientation(LinearLayout.HORIZONTAL);
            head.setGravity(Gravity.CENTER_VERTICAL);
            TextView name = new TextView(this);
            name.setText("Engine " + e.slot.toUpperCase());
            name.setTextSize(15);
            name.setTextColor(getColor(R.color.aether_fg));
            name.setTypeface(null, android.graphics.Typeface.BOLD);
            LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            head.addView(name, nlp);
            TextView status = new TextView(this);
            status.setId(R.id.status);
            status.setTextSize(12);
            status.setTextColor(getColor(R.color.aether_muted));
            status.setText("checking…");
            head.addView(status);
            card.addView(head);

            TextView acct = Ui.meta(this, e.user + " · " + e.kernelSlug);
            LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            alp.topMargin = Ui.dp(this, 2);
            card.addView(acct, alp);

            LinearLayout btns = new LinearLayout(this);
            btns.setOrientation(LinearLayout.HORIZONTAL);
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            blp.topMargin = Ui.dp(this, 10);

            Button wake = new Button(this);
            wake.setId(R.id.wake);
            wake.setText(getString(R.string.wake));
            wake.setTextSize(12);
            wake.setBackground(getDrawable(R.drawable.bg_pill_ghost));
            wake.setTextColor(getColor(R.color.aether_fg));
            wake.setOnClickListener(v -> wake(e, wake));
            LinearLayout.LayoutParams wlp = new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            btns.addView(wake, wlp);

            Button off = new Button(this);
            off.setId(R.id.off);
            off.setText(getString(R.string.shut_down));
            off.setTextSize(12);
            off.setBackground(getDrawable(R.drawable.bg_pill_ghost));
            off.setTextColor(getColor(R.color.aether_error));
            off.setOnClickListener(v -> confirmShutDown(e.slot));
            LinearLayout.LayoutParams olp = new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            olp.leftMargin = Ui.dp(this, 8);
            btns.addView(off, olp);

            card.addView(btns, blp);
            engineRows.addView(card);
            rowViews.put(e.slot, card);
            states.put(e.slot, "unknown");
        }
    }

    // ------------------------------------------------------------- polling

    private void pollLoop(int gen) {
        while (generation.get() == gen) {
            try {
                pollOnce();
                ui.post(this::render);
            } catch (Exception ignored) { }
            int wait = transitions.get() > 0 ? FAST_POLL_MS : POLL_MS;
            try { Thread.sleep(wait); } catch (InterruptedException ie) { return; }
        }
    }

    private void pollOnce() {
        Map<String, String> links = new ConcurrentHashMap<>();
        try {
            for (EngineCore.LiveLink l : EngineCore.liveLinks(
                    cfg.beaconTopic, cfg.beaconSecret, BEACON_LOOKBACK_S, 20_000)) {
                if (l.slot == null || cfg.bySlot(l.slot) == null) continue;
                if (!links.containsKey(l.slot)) links.put(l.slot, l.url);
            }
        } catch (Exception ignored) { }

        for (EngineCore.Engine e : cfg.engines) {
            String url = links.get(e.slot);
            if (url != null) {
                EngineCore.Health h = EngineCore.health(url, 15_000);
                if (h.isLive()) {
                    liveUrls.put(e.slot, url);
                    states.put(e.slot, "LIVE — " + String.join(", ", h.models));
                    continue;
                }
                liveUrls.remove(e.slot);
                states.put(e.slot, h.status == 200
                        ? "booting — model not loaded yet"
                        : "announced but unreachable (HTTP " + h.status + ")");
                continue;
            }
            liveUrls.remove(e.slot);
            states.put(e.slot, kernelState(e));
            ui.post(this::render);      // show each engine as soon as it is known
        }
    }

    private String kernelState(EngineCore.Engine e) {
        try {
            String s = EngineCore.kernelStatus(e, 20_000);
            switch (s == null ? "" : s) {
                case "running": return "booting — kernel running, model not warm";
                case "queued":  return "queued for a GPU";
                case "error":   return "off";
                default:        return s.isEmpty() ? "unknown" : s;
            }
        } catch (EngineCore.EngineException ex) {
            return "status failed (HTTP " + ex.status + ")";
        }
    }

    private void render() {
        for (Map.Entry<String, View> en : rowViews.entrySet()) {
            String slot = en.getKey();
            View card = en.getValue();
            String st = states.get(slot);
            boolean live = st != null && st.startsWith("LIVE");
            boolean busy = st != null && (st.startsWith("booting") || st.startsWith("queued"));

            TextView status = card.findViewById(R.id.status);
            status.setText(st == null ? "unknown" : st);
            status.setTextColor(getColor(live ? R.color.aether_ok
                    : (busy ? R.color.aether_warn : R.color.aether_muted)));

            Button wake = card.findViewById(R.id.wake);
            wake.setEnabled(!busy);
            /* Shut down stays clickable in every state. A disabled button is
               indistinguishable from a broken one, and the honest answer to
               "shut down an engine that is not reachable" is a sentence, not
               silence -- so the action always reports what it found. */
        }
    }

    // ------------------------------------------------------------- actions

    /**
     * Wake an engine and then WATCH it, reporting what Kaggle and /api/ps
     * actually say at each step. Nothing here claims an engine is ready before
     * /api/ps has returned 200 with a loaded model.
     */
    private void wake(final EngineCore.Engine e, final Button wake) {
        if (wake != null) wake.setEnabled(false);
        final String up = e.slot.toUpperCase(Locale.ROOT);
        states.put(e.slot, "wake requested -- pushing the kernel to Kaggle…");
        announce("Waking engine " + up + "…");
        transitions.incrementAndGet();
        render();
        bg.execute(() -> {
            String result;
            try {
                EngineCore.kernelPush(e, Credentials.renderNotebook(
                        Credentials.notebookTemplate(this), cfg, e.slot),
                        EngineCore.KERNEL_TITLE, true, 120_000);
                result = "kernel pushed -- queued for a GPU (booting takes several minutes)";
            } catch (Exception ex) {
                final String failure = "wake failed: " + ex.getMessage();
                transitions.decrementAndGet();
                states.put(e.slot, failure);
                ui.post(() -> {
                    render();
                    announce("Engine " + up + ": " + failure);
                    if (wake != null) wake.setEnabled(true);
                });
                return;
            }
            final String pushed = result;
            states.put(e.slot, pushed);
            ui.post(() -> {
                render();
                announce("Engine " + up + ": " + pushed + ". Watching it now.");
            });
            watchToLive(e.slot, System.currentTimeMillis() + WAKE_WATCH_MS, wake);
        });
    }

    /** Poll one engine until it is really live, or the window runs out. */
    private void watchToLive(final String slot, long deadline, final Button wake) {
        final String up = slot.toUpperCase(Locale.ROOT);
        final int myGen = generation.get();
        try {
            while (System.currentTimeMillis() < deadline && generation.get() == myGen) {
                String url = liveUrlFor(slot);
                if (url != null) {
                    EngineCore.Health h = EngineCore.health(url, 15_000);
                    if (h.isLive()) {
                        liveUrls.put(slot, url);
                        final String models = String.join(", ", h.models);
                        states.put(slot, "LIVE — " + models);
                        ui.post(() -> {
                            render();
                            announce("Engine " + up + " is LIVE — " + models);
                            if (wake != null) wake.setEnabled(true);
                        });
                        return;
                    }
                    states.put(slot, h.status == 200
                            ? "tunnel up, model still loading (not live yet)"
                            : "tunnel up but HTTP " + h.status);
                } else {
                    states.put(slot, kernelState(cfg.bySlot(slot)));
                }
                ui.post(this::render);
                try { Thread.sleep(FAST_POLL_MS); } catch (InterruptedException ie) { return; }
            }
            final String last = states.get(slot);
            states.put(slot, "still not live — last seen: " + last);
            ui.post(() -> {
                render();
                announce("Engine " + up + " did not come live inside "
                        + (WAKE_WATCH_MS / 60_000) + " minutes. Last seen: " + last);
                if (wake != null) wake.setEnabled(true);
            });
        } finally {
            transitions.decrementAndGet();
        }
    }

    /** The current tunnel URL for one slot, or null when it has not announced. */
    private String liveUrlFor(String slot) {
        try {
            for (EngineCore.LiveLink l : EngineCore.liveLinks(
                    cfg.beaconTopic, cfg.beaconSecret, BEACON_LOOKBACK_S, 20_000)) {
                if (slot.equals(l.slot)) return l.url;
            }
        } catch (Exception ignored) { }
        return null;
    }

    /** One engine: confirm first, because this releases a GPU quota. */
    private void confirmShutDown(final String slot) {
        new AlertDialog.Builder(this)
                .setTitle("Shut down engine " + slot.toUpperCase(Locale.ROOT) + "?")
                .setMessage("This releases the GPU that engine is holding. "
                        + "OFF is only reported once /api/ps stops answering.")
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.shut_down, (d, w) -> shutDown(slot))
                .show();
    }

    private void shutDown(String slot) {
        states.put(slot, "shutting down…");
        render();
        announce("Shutting down engine " + slot.toUpperCase(Locale.ROOT) + "…");
        bg.execute(() -> {
            String result = shutOne(slot);
            states.put(slot, result);
            ui.post(() -> {
                render();
                announce("Engine " + slot.toUpperCase(Locale.ROOT) + ": " + result);
            });
        });
    }

    private void shutDownAll() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.shut_down_all_title)
                .setMessage(R.string.shut_down_all_message)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.shut_down_all, (d, w) -> {
                    offAll.setEnabled(false);
                    announce("Shutting down every live engine…");
                    bg.execute(() -> {
                        /* Every engine with an announced tunnel, whether or not
                           this app had already seen it fully LIVE -- same reason
                           as in shutOne(). */
                        List<String> targets = new ArrayList<>();
                        for (EngineCore.Engine e : cfg.engines) {
                            if (liveUrls.containsKey(e.slot)) { targets.add(e.slot); continue; }
                            String url = liveUrlFor(e.slot);
                            if (url != null) { liveUrls.put(e.slot, url); targets.add(e.slot); }
                        }
                        if (targets.isEmpty()) {
                            ui.post(() -> {
                                offAll.setEnabled(true);
                                announce(getString(R.string.nothing_to_shut_down));
                            });
                            return;
                        }
                        StringBuilder report = new StringBuilder();
                        for (String slot : targets) {
                            states.put(slot, "shutting down…");
                            ui.post(this::render);
                            String result = shutOne(slot);
                            states.put(slot, result);
                            if (report.length() > 0) report.append("\n");
                            report.append(slot.toUpperCase(Locale.ROOT)).append(": ").append(result);
                            ui.post(this::render);
                        }
                        final String done = report.toString();
                        ui.post(() -> {
                            offAll.setEnabled(true);
                            announce(done);
                        });
                    });
                })
                .show();
    }

    /** Last action's outcome, always visible -- no action fails silently. */
    private void announce(String message) {
        ui.post(() -> note.setText(message));
    }

    private String shutOne(String slot) {
        /* Resolve the tunnel AT CLICK TIME. Relying on liveUrls was the bug:
           that map only ever held engines this app had already seen fully LIVE
           (/api/ps 200 WITH a loaded model), and pollOnce() actively removes
           the entry whenever an engine is booting, unreachable, or not yet
           polled. So after tapping Wake -- and for the whole multi-minute boot,
           and after any app restart -- the map was empty and this button did
           literally nothing, which is exactly "it can't turn off the engine". */
        String url = liveUrls.get(slot);
        if (url == null) url = liveUrlFor(slot);
        if (url == null) {
            return "nothing to shut down -- no tunnel announced for engine "
                    + slot.toUpperCase(Locale.ROOT) + " (Kaggle says: "
                    + kernelState(cfg.bySlot(slot)) + ")";
        }
        liveUrls.put(slot, url);
        transitions.incrementAndGet();
        try {
            states.put(slot, "shutting down -- waiting for /api/ps to stop answering…");
            ui.post(this::render);
            /* 8 checks x 4s: measured live, /api/ps goes 200 -> 502 -> 530 in
               about 20-30 seconds after /off is accepted. */
            EngineCore.Shutdown s = EngineCore.shutDownVerified(
                    url, cfg.offKey, 30_000, 8, 4_000);
            if (s.confirmed) liveUrls.remove(slot);
            return s.message;
        } catch (Exception ex) {
            return "shutdown failed: " + ex.getMessage();
        } finally {
            transitions.decrementAndGet();
        }
    }
}
