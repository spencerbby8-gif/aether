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
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
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
    private final Map<String, TextView> routingTexts = new ConcurrentHashMap<>();
    /** Only tunnels that answered /api/ps 200. Cleared the moment one fails. */
    private final Map<String, String> liveUrls = new ConcurrentHashMap<>();
    /** Last tunnel seen for a slot, kept only until a health check disproves it. */
    private final Map<String, String> tunnels = new ConcurrentHashMap<>();
    /**
     * Per-engine truth. Each slot carries its own phase, its own evidence and
     * the time /api/ps was last actually checked -- they are never derived from
     * each other, and "selected" in the routing list is not one of them.
     */
    private final Map<String, EngineCore.EngineState> states = new ConcurrentHashMap<>();
    /**
     * An action the user just triggered, consumed by the next classification.
     * This is the only thing that may produce ERROR or QUOTA, which is what
     * keeps a stale tunnel from being reported as a failure.
     */
    private final Map<String, EngineCore.Action> pendingActions = new ConcurrentHashMap<>();
    /**
     * When a shutdown was confirmed by watching /api/ps stop answering, per
     * slot. Kaggle's kernel status lags behind that measurement, so this is what
     * keeps a confirmed OFF from flipping back to WAKING on the next poll. It is
     * cleared the moment an engine answers 200 again, so a revived engine is
     * never hidden by it.
     */
    private final Map<String, Long> confirmedOffAt = new ConcurrentHashMap<>();
    /**
     * Slots with a wake in flight. A second push does not replace a running
     * version -- Kaggle keeps the old one alive and offers no API to stop it
     * (issue #388) -- so a double tap would leave two engines holding GPUs and
     * make shutdown look like it failed. Refuse the second push instead.
     */
    private final Set<String> waking = ConcurrentHashMap.newKeySet();

    /**
     * THE BUG THIS SEPARATION FIXES: this used to be one single-thread executor
     * shared by the poll loop and the buttons. pollLoop() never returns while the
     * screen is open, so it owned the only worker thread and every wake or
     * shutdown task sat in the queue behind it, forever. The UI text was set
     * synchronously before execute(), so the card said "WAKING" and the note said
     * "Shutting down…" while the work never ran at all -- exactly "it can't turn
     * the engine on or off". Bumping the generation (Check now, leaving the
     * screen) ended the loop and let the stuck task run, which is why it looked
     * like it sometimes worked.
     *
     * So: one thread for polling, and a separate pool for actions, so a 15-minute
     * wake watch can never block a shutdown.
     */
    private final ExecutorService pollExec = Executors.newSingleThreadExecutor(daemonFactory());
    private final ExecutorService actionExec = Executors.newCachedThreadPool(daemonFactory());

    private static ThreadFactory daemonFactory() {
        return r -> { Thread t = new Thread(r); t.setDaemon(true); return t; };
    }
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
            /* Still worth reporting: "the screen says no credentials" is a
               distinct failure and otherwise invisible from here. */
            EngineCore.publish(telemetryTopicOrEmpty(),
                    "build " + BuildConfig.VERSION_NAME + "(" + BuildConfig.VERSION_CODE
                            + ") NO CREDENTIALS BAKED", 15_000);
            return;
        }
        /* Confirms which build is actually installed, from the device itself. */
        telemetry("settings opened on " + android.os.Build.MANUFACTURER + " "
                + android.os.Build.MODEL + ", Android " + android.os.Build.VERSION.RELEASE);

        buildRoutingRows();
        buildEngineRows();
        offAll.setOnClickListener(v -> shutDownAll());

        /* Paint the cards at once. Waiting for the first poll -- a beacon fetch
           plus a health check per engine -- left every button in its initial
           state for up to a minute, which reads as a screen that does nothing. */
        render();

        note.setText("Every status here comes from a real check, and each engine is judged "
                + "on its own.\n\nLIVE — /api/ps returned 200 with a loaded model. "
                + "WAKING — a wake was accepted, or Kaggle says the kernel is queued or "
                + "running, or the kernel answers 200 with no model yet. "
                + "OFF — nothing answers /api/ps and Kaggle reports the kernel gone. "
                + "QUOTA — Kaggle refused the wake for quota or limits. "
                + "ERROR — an action you just pressed actually failed. A dead tunnel from an "
                + "old announcement is not an error and is never shown as one."
                + "\n\nShutting an engine down is what releases the GPU quota, and OFF is only "
                + "reported once /api/ps has stopped answering."
                /* Printed so an installed build can be identified on the phone
                   itself. Every build used to be 1.0.0, which made it impossible
                   to tell whether a fix had actually been installed. */
                + "\n\nbuild " + BuildConfig.VERSION_NAME + " (" + BuildConfig.VERSION_CODE
                + ") · " + getPackageName());
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (cfg == null) return;
        int gen = generation.incrementAndGet();
        pollExec.execute(() -> pollLoop(gen));
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
        pollExec.shutdownNow();
        actionExec.shutdownNow();
    }

    /** Force a poll immediately instead of waiting for the next tick. */
    private void checkNow() {
        announce("Checking every engine now…");
        /* Deliberately does NOT overwrite the measured states with "checking…".
           Replacing real evidence with a placeholder is the same class of lie
           as claiming LIVE early: the card keeps showing what was last verified
           and how old it is, and the poll replaces it with a fresh measurement. */
        render();
        int gen = generation.incrementAndGet();
        pollExec.execute(() -> pollLoop(gen));
        /* And print exactly what this phone can and cannot reach. The failure is
           on a device nobody can inspect from here, so the phone has to be the
           one that reports it. */
        actionExec.execute(() -> {
            final String report = diagnostics();
            ui.post(() -> note.setText(report));
            /* The same report, sent where it can actually be read. */
            EngineCore.publish(cfg.telemetryTopic,
                    "build " + BuildConfig.VERSION_NAME + "(" + BuildConfig.VERSION_CODE
                            + ")\n" + EngineCore.scrubUrls(report), 15_000);
        });
    }

    /**
     * Every dependency of the status pipeline, measured and printed on screen.
     *
     * This exists because "WAKING for ever" has at least three causes that look
     * identical from the outside -- the engine still loading, the discovery
     * service unreachable, or the tunnels unreachable -- and only the phone can
     * tell them apart. Read line 1: if discovery says FAILED, nothing downstream
     * can work, and that is the whole problem.
     */
    private String diagnostics() {
        StringBuilder sb = new StringBuilder();
        sb.append("DIAGNOSTICS  build ").append(BuildConfig.VERSION_NAME)
                .append(" (").append(BuildConfig.VERSION_CODE).append(")  ")
                .append(getPackageName()).append('\n');

        // 1. Discovery: can this phone read the beacon at all?
        try {
            List<EngineCore.LiveLink> links = EngineCore.liveLinks(
                    cfg.beaconTopic, cfg.beaconSecret, BEACON_LOOKBACK_S, 20_000);
            sb.append("1 discovery ntfy.sh: OK, ").append(links.size())
                    .append(" announcement(s) in ").append(BEACON_LOOKBACK_S / 3600).append("h\n");
        } catch (Exception ex) {
            sb.append("1 discovery ntfy.sh: FAILED -- ").append(ex.getMessage())
                    .append("\n   ^ if this says FAILED, no engine can ever be found\n");
        }

        // 2. Kaggle, and every tunnel each engine has announced.
        for (EngineCore.Engine e : cfg.engines) {
            String kg;
            try { kg = EngineCore.kernelStatus(e, 20_000); }
            catch (Exception ex) { kg = "FAILED: " + ex.getMessage(); }
            List<String> urls = new ArrayList<>();
            try {
                urls = EngineCore.urlsFor(cfg.beaconTopic, cfg.beaconSecret, e.slot,
                        BEACON_LOOKBACK_S, 20_000, 6);
            } catch (Exception ignored) { }
            sb.append("2 engine ").append(e.slot.toUpperCase(Locale.ROOT))
                    .append(": Kaggle=").append(kg)
                    .append(", ").append(urls.size()).append(" tunnel(s)");
            for (int i = 0; i < urls.size(); i++) {
                EngineCore.Health h = EngineCore.health(urls.get(i), 15_000);
                sb.append(i == 0 ? " -> " : ", ")
                        .append('[').append(i).append("] HTTP ").append(h.status)
                        .append(h.models.isEmpty() ? "" : " models=" + h.models.size());
            }
            sb.append('\n');
        }
        sb.append("3 how to read it: HTTP 200 with models = LIVE. 200 with no models = ")
                .append("still loading. 530 or -1 = that tunnel is dead. 0 tunnels with ")
                .append("Kaggle running = booting, no tunnel yet, about 5 minutes.");
        return EngineCore.scrubUrls(sb.toString());
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
        /* Pinning is a routing choice; it says nothing about health, so the
           engine's own measured phase is read separately and shown as such. */
        final EngineCore.EngineState st = states.get(o);
        if (st != null && st.isLive()) {
            announce("Engine " + up + " pinned. It is LIVE, so only it will answer.");
            return;
        }
        final EngineCore.Engine e = cfg == null ? null : cfg.bySlot(o);
        new AlertDialog.Builder(this)
                .setTitle("Engine " + up + " is not live")
                .setMessage("Pinned, so only engine " + up + " will be used. Its own measured "
                        + "status is " + (st == null ? "UNKNOWN" : badge(st.phase)) + ": "
                        + (st == null ? "not checked yet" : st.detail)
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
        routingTexts.clear();
        String[] opts = {EngineRouter.AUTO, "a", "b", "c"};
        for (String o : opts) {
            TextView row = new TextView(this);
            row.setTextSize(14);
            row.setBackgroundResource(R.drawable.bg_card);
            row.setPadding(Ui.dp(this, 14), Ui.dp(this, 12), Ui.dp(this, 14), Ui.dp(this, 12));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.topMargin = Ui.dp(this, 6);
            row.setLayoutParams(lp);
            row.setOnClickListener(v -> chooseMode(o));
            routingRows.addView(row);
            routingTexts.put(o, row);
        }
        renderRouting();
    }

    /**
     * Selection and health are two separate facts on one line. Choosing an
     * engine only decides where traffic goes; it says nothing about whether
     * that engine is running, so the phase is drawn from the engine's own
     * measured state and the marker is labelled "routing only".
     */
    private void renderRouting() {
        String current = EngineRouter.canonical(mode());
        for (Map.Entry<String, TextView> en : routingTexts.entrySet()) {
            String o = en.getKey();
            boolean selected = current.equals(o);
            StringBuilder sb = new StringBuilder();
            sb.append(selected ? "●  " : "○  ");
            if (EngineRouter.AUTO.equals(o)) {
                sb.append("AUTO — first healthy, fails over A→B→C");
            } else {
                EngineCore.EngineState st = states.get(o);
                sb.append("Engine ").append(o.toUpperCase(Locale.ROOT))
                        .append(" — pinned, no failover · ")
                        .append(st == null ? "UNKNOWN" : badge(st.phase));
            }
            if (selected) sb.append("   (selected — routing only)");
            TextView row = en.getValue();
            row.setText(sb.toString());
            row.setTextColor(getColor(selected ? R.color.aether_fg : R.color.aether_muted));
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
            /* Unknown, not "off": nothing has been measured yet. Claiming OFF
               here would be the same kind of lie as claiming LIVE. */
            states.put(e.slot, new EngineCore.EngineState(e.slot, EngineCore.Phase.UNKNOWN,
                    "not checked yet — the first /api/ps poll decides", null, 0, null, null));
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
        /* Step 1 -- resolve. The beacon only proves a URL was published at some
           point; it is a candidate list, never a status. */
        Map<String, String> announced = new ConcurrentHashMap<>();
        String beaconError = null;
        try {
            for (EngineCore.LiveLink l : EngineCore.liveLinks(
                    cfg.beaconTopic, cfg.beaconSecret, BEACON_LOOKBACK_S, 20_000)) {
                if (l.slot == null || cfg.bySlot(l.slot) == null) continue;
                if (!announced.containsKey(l.slot)) announced.put(l.slot, l.url);
            }
        } catch (Exception ex) {
            /* NOT swallowed. This used to be `catch (Exception ignored) {}`, so a
               phone that cannot reach the discovery service saw an empty list,
               fell back to Kaggle's "running", and showed WAKING for ever with
               no clue that discovery -- not the engine -- was the thing failing.
               That is indistinguishable from a slow boot, which is the worst
               possible way to report it. */
            beaconError = String.valueOf(ex.getMessage());
        }

        for (EngineCore.Engine e : cfg.engines) {
            /* Step 2 -- obtain a URL: the newest announcement, else the last one
               that actually answered. */
            String url = announced.get(e.slot);
            if (url == null) url = tunnels.get(e.slot);

            /* Step 3 -- health-check it. This is the only evidence that counts. */
            int status = EngineCore.NO_CHECK;
            List<String> models = new ArrayList<>();
            if (url != null) {
                EngineCore.Health h = EngineCore.health(url, 15_000);
                status = h.status;
                models = h.models;
                if (h.status == 200) {
                    tunnels.put(e.slot, url);
                    confirmedOffAt.remove(e.slot);   // it is answering: not off
                } else {
                    /* Step 4 -- a tunnel that will not answer is stale. Drop it
                       here so the next poll re-resolves instead of re-reporting
                       the same dead URL as an error. */
                    tunnels.remove(e.slot);
                    liveUrls.remove(e.slot);
                    url = null;
                }
            } else {
                tunnels.remove(e.slot);
            }

            /* Step 5 -- classify. Kaggle's own kernel status is only consulted
               when the engine is not answering, and only to tell WAKING from
               OFF; a dead tunnel never becomes ERROR. */
            String kg = status == 200 ? null : safeKernelStatus(e);
            EngineCore.Action pending = pendingActions.remove(e.slot);
            Long offAt = confirmedOffAt.get(e.slot);
            EngineCore.EngineState st = EngineCore.classify(
                    e.slot, status, models, url, kg, pending, offAt == null ? 0L : offAt);
            /* A discovery outage is reported, not hidden. It never overrides a
               real /api/ps measurement -- only the "nothing answering" case,
               where without it the screen would claim a boot that may not be
               happening. */
            if (beaconError != null && url == null) {
                st = new EngineCore.EngineState(e.slot, st.phase,
                        st.detail + " — cannot reach the discovery service, so no tunnel can "
                                + "be found: " + beaconError,
                        null, st.verifiedAtMs, st.models, st.kaggleStatus);
            }
            states.put(e.slot, st);
            if (st.isLive()) liveUrls.put(e.slot, st.url); else liveUrls.remove(e.slot);
            ui.post(this::render);      // show each engine as soon as it is known
        }
    }

    /** Kaggle's kernel status, or null when it could not be read. Never throws. */
    private String safeKernelStatus(EngineCore.Engine e) {
        if (e == null) return null;
        try {
            return EngineCore.kernelStatus(e, 20_000);
        } catch (Exception ex) {
            return null;
        }
    }

    private void render() {
        for (Map.Entry<String, View> en : rowViews.entrySet()) {
            String slot = en.getKey();
            View card = en.getValue();
            EngineCore.EngineState st = states.get(slot);

            TextView status = card.findViewById(R.id.status);
            if (st == null) {
                status.setText("not checked yet");
                status.setTextColor(getColor(R.color.aether_muted));
            } else {
                /* The badge is the phase, the second line is the evidence, and
                   the age says when that evidence was measured. None of it can
                   contain a tunnel: EngineState scrubs URLs on the way in. */
                String age = st.verifiedAtMs == 0
                        ? "no /api/ps answer"
                        : "checked " + ago(System.currentTimeMillis() - st.verifiedAtMs);
                status.setText(badge(st.phase) + "  ·  " + age + "\n" + st.detail);
                status.setTextColor(getColor(colorFor(st.phase)));
            }

            Button wake = card.findViewById(R.id.wake);
            /* Disabled only while a wake is genuinely in progress, so a second
               tap cannot queue another GPU run by accident. */
            wake.setEnabled(st == null || st.phase != EngineCore.Phase.WAKING);
            /* Shut down stays clickable in every state. A disabled button is
               indistinguishable from a broken one, and the honest answer to
               "shut down an engine that is not reachable" is a sentence, not
               silence -- so the action always reports what it found. */
        }
        renderRouting();      // the pinned engine's phase, refreshed with the rest
    }

    private static String badge(EngineCore.Phase p) {
        switch (p) {
            case LIVE:    return "LIVE";
            case WAKING:  return "WAKING";
            case OFF:     return "OFF";
            case QUOTA:   return "QUOTA";
            case ERROR:   return "ERROR";
            default:      return "UNKNOWN";
        }
    }

    private int colorFor(EngineCore.Phase p) {
        switch (p) {
            case LIVE:    return R.color.aether_ok;
            case WAKING:  return R.color.aether_warn;
            case QUOTA:   return R.color.aether_warn;
            case ERROR:   return R.color.aether_error;
            default:      return R.color.aether_muted;
        }
    }

    private static String ago(long ms) {
        long s = ms / 1000;
        if (s < 5) return "just now";
        if (s < 60) return s + "s ago";
        long m = s / 60;
        if (m < 60) return m + " min ago";
        return (m / 60) + " h ago";
    }

    // ------------------------------------------------------------- actions

    /**
     * Wake an engine and then WATCH it, reporting what Kaggle and /api/ps
     * actually say at each step. Nothing here claims an engine is ready before
     * /api/ps has returned 200 with a loaded model.
     */
    private void wake(final EngineCore.Engine e, final Button wake) {
        final String up = e.slot.toUpperCase(Locale.ROOT);
        /* One push at a time per engine. A second one would start another
           concurrent version that cannot be stopped from the API. */
        if (!waking.add(e.slot)) {
            announce("Engine " + up + " is already waking. A second push would start "
                    + "another version Kaggle cannot be told to stop.");
            return;
        }
        if (wake != null) wake.setEnabled(false);
        /* A new wake supersedes any earlier confirmed shutdown, or the boot
           would be reported OFF for as long as that record lived. */
        confirmedOffAt.remove(e.slot);
        /* "WAKING" the moment it is pressed. Nothing stronger is claimed until
           /api/ps answers 200 with a loaded model. */
        states.put(e.slot, new EngineCore.EngineState(e.slot, EngineCore.Phase.WAKING,
                "waking — sending the kernel to Kaggle", null, 0, null, null));
        announce("Waking engine " + up + "…");
        transitions.incrementAndGet();
        render();
        actionExec.execute(() -> {
            try {
                EngineCore.kernelPush(e, Credentials.renderNotebook(
                        Credentials.notebookTemplate(this), cfg, e.slot),
                        EngineCore.KERNEL_TITLE, true, 120_000);
            } catch (Exception ex) {
                transitions.decrementAndGet();
                waking.remove(e.slot);
                String msg = String.valueOf(ex.getMessage());
                int code = ex instanceof EngineCore.EngineException
                        ? ((EngineCore.EngineException) ex).status : -1;
                /* A quota refusal is its own state, not a generic error. */
                EngineCore.Action a = EngineCore.isQuotaRefusal(code, msg)
                        ? EngineCore.Action.quotaHit("wake", msg)
                        : EngineCore.Action.failed("wake", msg);
                telemetry("wake FAILED: engine " + up + " -- " + msg);
                states.put(e.slot, EngineCore.classify(e.slot, EngineCore.NO_CHECK, null,
                        null, safeKernelStatus(e), a));
                final EngineCore.EngineState bad = states.get(e.slot);
                ui.post(() -> {
                    render();
                    announce("Engine " + up + ": " + badge(bad.phase) + " — " + bad.detail);
                    if (wake != null) wake.setEnabled(true);
                });
                return;
            }
            telemetry("wake accepted by Kaggle: engine " + up);
            /* Accepted. That earns WAKING and nothing more. */
            states.put(e.slot, new EngineCore.EngineState(e.slot, EngineCore.Phase.WAKING,
                    "waking — Kaggle accepted the kernel; booting takes several minutes",
                    null, 0, null, null));
            ui.post(() -> {
                render();
                announce("Engine " + up + ": kernel accepted. It becomes LIVE only when "
                        + "/api/ps answers 200 with a model.");
            });
            watchToLive(e.slot, System.currentTimeMillis() + WAKE_WATCH_MS, wake);
        });
    }

    /** Poll one engine until /api/ps really answers, or the window runs out. */
    private void watchToLive(final String slot, long deadline, final Button wake) {
        final String up = slot.toUpperCase(Locale.ROOT);
        final int myGen = generation.get();
        try {
            while (System.currentTimeMillis() < deadline && generation.get() == myGen) {
                /* Probe EVERY tunnel this slot has announced, not just the first.
                   One engine can have several in the window (Kaggle leaves old
                   versions running), and a watcher that only ever looks at the
                   first match can sit on a dead one for ever while the real
                   tunnel goes unexamined -- which reads as "stuck on WAKING". */
                List<String> urls = new ArrayList<>();
                try {
                    for (String u : EngineCore.urlsFor(cfg.beaconTopic, cfg.beaconSecret,
                            slot, BEACON_LOOKBACK_S, 20_000, 6)) urls.add(u);
                } catch (Exception ignored) { }
                String url = null;
                int status = EngineCore.NO_CHECK;
                List<String> models = new ArrayList<>();
                for (String u : urls) {
                    EngineCore.Health h = EngineCore.health(u, 15_000);
                    if (h.status == 200 && !h.models.isEmpty()) {
                        url = u; status = h.status; models = h.models;
                        break;                                  // fully live: stop here
                    }
                    if (h.status == 200 && status != 200) { url = u; status = h.status; }
                }
                if (url != null) { tunnels.put(slot, url); confirmedOffAt.remove(slot); }
                else { tunnels.remove(slot); liveUrls.remove(slot); }
                /* A new wake in progress is never shadowed by an earlier
                   confirmed shutdown: wake() clears it, and 0 is passed here. */
                EngineCore.EngineState st = EngineCore.classify(slot, status, models, url,
                        status == 200 ? null : safeKernelStatus(cfg.bySlot(slot)), null, 0L);
                states.put(slot, st);
                if (st.isLive()) {
                    liveUrls.put(slot, st.url);
                    telemetry("engine " + up + " LIVE after "
                            + ((System.currentTimeMillis() - (deadline - WAKE_WATCH_MS)) / 1000)
                            + "s");
                    final EngineCore.EngineState live = st;
                    ui.post(() -> {
                        render();
                        announce("Engine " + up + " is LIVE — "
                                + String.join(", ", live.models));
                        if (wake != null) wake.setEnabled(true);
                    });
                    return;
                }
                ui.post(this::render);
                try { Thread.sleep(FAST_POLL_MS); } catch (InterruptedException ie) { return; }
            }
            telemetry("engine " + up + " did NOT come live inside "
                    + (WAKE_WATCH_MS / 60_000) + " min");
            ui.post(() -> {
                render();
                announce("Engine " + up + " did not answer /api/ps inside "
                        + (WAKE_WATCH_MS / 60_000) + " minutes. It is not LIVE.");
                if (wake != null) wake.setEnabled(true);
            });
        } finally {
            transitions.decrementAndGet();
            waking.remove(slot);
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

    private void shutDown(final String slot) {
        announce("Shutting down engine " + slot.toUpperCase(Locale.ROOT) + "…");
        actionExec.execute(() -> {
            final EngineCore.EngineState result = shutOne(slot);
            states.put(slot, result);
            telemetry("shutdown engine " + slot.toUpperCase(Locale.ROOT) + ": "
                    + badge(result.phase) + " -- " + result.detail);
            ui.post(() -> {
                render();
                announce("Engine " + slot.toUpperCase(Locale.ROOT) + ": "
                        + badge(result.phase) + " — " + result.detail);
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
                    actionExec.execute(() -> {
                        /* Every engine with an announced tunnel, whether or not
                           this app had already seen it fully LIVE -- same reason
                           as in shutOne(). */
                        List<String> targets = new ArrayList<>();
                        for (EngineCore.Engine e : cfg.engines) {
                            if (liveUrls.containsKey(e.slot) || tunnels.containsKey(e.slot)) {
                                targets.add(e.slot);
                                continue;
                            }
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
                            ui.post(this::render);
                            EngineCore.EngineState result = shutOne(slot);
                            states.put(slot, result);
                            if (report.length() > 0) report.append("\n");
                            report.append(slot.toUpperCase(Locale.ROOT)).append(": ")
                                    .append(badge(result.phase)).append(" — ").append(result.detail);
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


    /** The telemetry topic even when credentials failed to load. */
    private String telemetryTopicOrEmpty() {
        try {
            Credentials.Config c = Credentials.load(this);
            return c == null ? "" : c.telemetryTopic;
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * Report one line to the telemetry topic.
     *
     * This is how an installed build can be observed at all: the build host has
     * no route to the phone, but both sides can reach ntfy. It runs off the UI
     * thread, publishes nothing secret (URLs are scrubbed, keys never leave the
     * device), and can never affect what the user sees.
     */
    private void telemetry(final String what) {
        if (cfg == null || cfg.telemetryTopic == null || cfg.telemetryTopic.isEmpty()) return;
        final String body = "build " + BuildConfig.VERSION_NAME + "(" + BuildConfig.VERSION_CODE
                + ") " + EngineCore.scrubUrls(what);
        actionExec.execute(() -> EngineCore.publish(cfg.telemetryTopic, body, 15_000));
    }

    /** Last action's outcome, always visible -- no action fails silently. */
    private void announce(String message) {
        /* Belt and braces: EngineState already scrubs, and nothing here should
           ever hold a tunnel, but the screen must never print a raw endpoint. */
        final String safe = EngineCore.scrubUrls(message);
        ui.post(() -> note.setText(safe));
    }

    private EngineCore.EngineState shutOne(String slot) {
        /* EVERY tunnel this slot has announced, not just the newest. Kaggle
           leaves previous kernel versions running after a new push and offers no
           API to stop them (issue #388), so each has its own tunnel and its own
           GPU. Killing only the newest one is why shutdown looked like it
           failed. */
        List<String> urls = new ArrayList<>();
        String known = liveUrls.get(slot);
        if (known == null) known = tunnels.get(slot);
        if (known != null) urls.add(known);
        try {
            for (String u : EngineCore.urlsFor(cfg.beaconTopic, cfg.beaconSecret,
                    slot, BEACON_LOOKBACK_S, 20_000, 6)) {
                if (!urls.contains(u)) urls.add(u);
            }
        } catch (Exception ignored) { }

        if (urls.isEmpty()) {
            /* Nothing announced. Not an error -- there is nothing to shut down.
               Classify from Kaggle instead of inventing a failure. */
            tunnels.remove(slot);
            liveUrls.remove(slot);
            return EngineCore.classify(slot, EngineCore.NO_CHECK, null, null,
                    safeKernelStatus(cfg.bySlot(slot)), null, 0L);
        }

        transitions.incrementAndGet();
        try {
            EngineCore.ShutdownAll r = EngineCore.shutDownEvery(
                    urls, cfg.offKey, 30_000, 8, 4_000);
            tunnels.remove(slot);
            liveUrls.remove(slot);
            if (r.allDown) {
                /* Every instance that was answering has been watched stopping. */
                confirmedOffAt.put(slot, System.currentTimeMillis());
                return new EngineCore.EngineState(slot, EngineCore.Phase.OFF,
                        "off — " + r.message, null, System.currentTimeMillis(), null, null);
            }
            /* A real failure: an instance accepted /off and kept answering. */
            return EngineCore.classify(slot, EngineCore.NO_CHECK, null, null,
                    safeKernelStatus(cfg.bySlot(slot)),
                    EngineCore.Action.failed("shutdown", r.message), 0L);
        } catch (Exception ex) {
            return EngineCore.classify(slot, EngineCore.NO_CHECK, null, null, null,
                    EngineCore.Action.failed("shutdown", String.valueOf(ex.getMessage())), 0L);
        } finally {
            transitions.decrementAndGet();
        }
    }
}
