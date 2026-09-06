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
import androidx.appcompat.app.AppCompatActivity;

import java.util.ArrayList;
import java.util.List;
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
 * SHUT-DOWN-ALL confirms each engine individually via confirmedDown() and names
 * any that did not go down, rather than reporting a sweep it did not verify.
 */
public class SettingsActivity extends AppCompatActivity {

    private static final int POLL_MS = 15_000;
    private static final int BEACON_LOOKBACK_S = 3 * 3600;

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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);

        routingRows = findViewById(R.id.routing_rows);
        engineRows = findViewById(R.id.engine_rows);
        note = findViewById(R.id.settings_note);
        offAll = findViewById(R.id.off_all);

        findViewById(R.id.back_btn).setOnClickListener(v -> finish());

        cfg = Credentials.load(this);
        if (cfg == null || cfg.engines.isEmpty()) {
            note.setText("No engine credentials are baked into this build.");
            return;
        }

        buildRoutingRows();
        buildEngineRows();
        offAll.setOnClickListener(v -> shutDownAll());

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

    // ------------------------------------------------------------- routing

    private String mode() {
        return getSharedPreferences("aether_console", MODE_PRIVATE)
                .getString("mode", EngineRouter.AUTO);
    }

    private void setMode(String m) {
        getSharedPreferences("aether_console", MODE_PRIVATE).edit().putString("mode", m).apply();
        buildRoutingRows();
    }

    private void buildRoutingRows() {
        routingRows.removeAllViews();
        String[] opts = {EngineRouter.AUTO, "a", "b", "c"};
        for (String o : opts) {
            boolean selected = mode().equals(o);
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
            row.setOnClickListener(v -> setMode(o));
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
            off.setEnabled(false);
            off.setOnClickListener(v -> shutDown(e.slot, off));
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
            try { Thread.sleep(POLL_MS); } catch (InterruptedException ie) { return; }
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
            Button off = card.findViewById(R.id.off);
            wake.setEnabled(!busy);
            off.setEnabled(live || busy);
        }
    }

    // ------------------------------------------------------------- actions

    private void wake(EngineCore.Engine e, Button wake) {
        wake.setEnabled(false);
        states.put(e.slot, "queued for a GPU");
        render();
        bg.execute(() -> {
            String result;
            try {
                EngineCore.kernelPush(e, Credentials.renderNotebook(
                        Credentials.notebookTemplate(this), cfg, e.slot),
                        EngineCore.KERNEL_TITLE, true, 120_000);
                result = "queued for a GPU";
            } catch (Exception ex) {
                result = "wake failed: " + ex.getMessage();
            }
            states.put(e.slot, result);
            ui.post(this::render);
        });
    }

    private void shutDown(String slot, Button off) {
        off.setEnabled(false);
        states.put(slot, "shutting down…");
        render();
        bg.execute(() -> {
            states.put(slot, shutOne(slot));
            ui.post(this::render);
        });
    }

    private void shutDownAll() {
        offAll.setEnabled(false);
        bg.execute(() -> {
            List<String> targets = new ArrayList<>(liveUrls.keySet());
            if (targets.isEmpty()) {
                ui.post(() -> { offAll.setEnabled(true); });
                return;
            }
            for (String slot : targets) {
                states.put(slot, "shutting down…");
                states.put(slot, shutOne(slot));
                ui.post(this::render);
            }
            ui.post(() -> offAll.setEnabled(true));
        });
    }

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
}
