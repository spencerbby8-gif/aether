package com.aether.app;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The primary screen: a chat-first conversation with Aether.
 *
 * Engine selection, wake and shutdown live in Settings, not here -- the main
 * screen stays focused on the conversation. The header chip is the only engine
 * surface, and it is a read-only status that deep-links to Settings.
 *
 * STREAMING. The assistant bubble is built in three zones that fill only when
 * the engine emits the matching event:
 *
 *   thinking  -- dim rows, from {"message":{"thinking":...}}
 *   tools     -- accent monospace tiles, from thinking lines that are actual
 *                tool calls ("🛠️ web_search(...)", "↳ ... returned N chars")
 *   content   -- the answer, appended token as it arrives
 *
 * Nothing here is a looping placeholder: a thinking or tool row exists only
 * because the engine sent it, and the "waiting" dot disappears the moment the
 * first real token lands. That is the difference between "dynamic, based on
 * actual engine events" and a static fake animation.
 *
 * CANCELLATION. The send button becomes a stop button while a turn is in flight;
 * stop flips the same flag EngineCore polls between NDJSON lines, so the socket
 * closes instead of letting the generation finish in the background.
 */
public class ChatActivity extends AppCompatActivity {

    private LinearLayout msgList;
    private ScrollView scroll;
    private EditText input;
    private ImageButton sendBtn;
    private ImageButton stopBtn;
    private TextView chip;
    private TextView headerSub;
    private View emptyView;

    private Credentials.Config cfg;
    private final ExecutorService bg = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());

    /** Cancel flag for the in-flight turn. Polled by EngineCore between lines. */
    private boolean[] cancelFlag = null;

    private final List<EngineRouter.SlotState> lastStates = new ArrayList<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_chat);

        msgList = findViewById(R.id.msg_list);
        scroll = findViewById(R.id.chat_scroll);
        input = findViewById(R.id.input);
        sendBtn = findViewById(R.id.send_btn);
        stopBtn = findViewById(R.id.stop_btn);
        chip = findViewById(R.id.engine_chip);
        headerSub = findViewById(R.id.header_sub);

        cfg = Credentials.load(this);
        if (cfg == null || cfg.engines.isEmpty()) {
            showErrorGlobal("This build has no engine credentials baked in.");
            return;
        }
        headerSub.setText("chat, tools, search, commands");

        chip.setOnClickListener(v -> openSettings());
        findViewById(R.id.settings_btn).setOnClickListener(v -> openSettings());

        sendBtn.setOnClickListener(v -> onSend());
        stopBtn.setOnClickListener(v -> {
            if (cancelFlag != null) cancelFlag[0] = true;
        });

        input.setOnEditorActionListener((v, actionId, event) -> {
            onSend();
            return true;
        });

        showEmptyState();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshChip();
    }

    private void openSettings() {
        startActivity(new Intent(this, SettingsActivity.class));
    }

    // ----------------------------------------------------------- status chip

    private void refreshChip() {
        bg.execute(() -> {
            List<EngineRouter.SlotState> states = pollStates();
            EngineRouter.Decision d = EngineRouter.route(mode(), states);
            ui.post(() -> {
                synchronized (lastStates) { lastStates.clear(); lastStates.addAll(states); }
                if (d.ok()) {
                    chip.setText("● " + d.slot.toUpperCase() + (mode().equals(EngineRouter.AUTO) ? " · auto" : ""));
                    chip.setTextColor(getColor(R.color.aether_ok));
                } else {
                    String any = null;
                    for (EngineRouter.SlotState s : states) {
                        if (s.reason != null && s.reason.startsWith("booting")) { any = s.slot; break; }
                    }
                    chip.setText(any != null ? "◌ " + any.toUpperCase() + " waking" : "○ off");
                    chip.setTextColor(getColor(any != null ? R.color.aether_warn : R.color.aether_muted));
                }
            });
        });
    }

    private String mode() {
        return getSharedPreferences("aether_console", MODE_PRIVATE)
                .getString("mode", EngineRouter.AUTO);
    }

    private List<EngineRouter.SlotState> pollStates() {
        List<EngineRouter.SlotState> out = new ArrayList<>();
        java.util.Map<String, String> links = new java.util.HashMap<>();
        try {
            for (EngineCore.LiveLink l : EngineCore.liveLinks(
                    cfg.beaconTopic, cfg.beaconSecret, 3 * 3600, 20_000)) {
                if (l.slot == null || cfg.bySlot(l.slot) == null) continue;
                if (!links.containsKey(l.slot)) links.put(l.slot, l.url);
            }
        } catch (Exception ignored) { }
        for (EngineCore.Engine e : cfg.engines) {
            String url = links.get(e.slot);
            if (url != null) {
                EngineCore.Health h = EngineCore.health(url, 12_000);
                out.add(new EngineRouter.SlotState(e.slot, h.isLive(), h.isLive() ? url : null,
                        h.isLive() ? null : "booting", h.status));
            } else {
                out.add(new EngineRouter.SlotState(e.slot, false, null, "off", -1));
            }
        }
        return out;
    }

    // ------------------------------------------------------------- messages

    private void showEmptyState() {
        msgList.removeAllViews();
        emptyView = Ui.centered(this,
                "Ask Aether anything.\n\nIt can search the web, crawl pages, run commands "
                + "and reason out loud.\n\nNo engine is live yet -- it wakes automatically "
                + "when you send a message, or wake one ahead of time in Settings.",
                14, Ui.DIM);
        msgList.addView(emptyView);
    }

    private void clearEmpty() {
        if (emptyView != null && emptyView.getParent() != null) {
            msgList.removeView(emptyView);
            emptyView = null;
        }
    }

    private void scrollBottom() {
        scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
    }

    private TextView addUserBubble(String text) {
        clearEmpty();
        LinearLayout wrap = new LinearLayout(this);
        wrap.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Ui.dp(this, 10);
        wrap.setLayoutParams(lp);

        TextView body = Ui.tv(this, text, 15, Ui.PRIMARY);
        body.setBackgroundResource(R.drawable.bg_bubble_out);
        body.setPadding(Ui.dp(this, 14), Ui.dp(this, 10), Ui.dp(this, 14), Ui.dp(this, 10));
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        blp.gravity = Gravity.END;
        int side = Ui.dp(this, 40);
        blp.setMargins(side, 0, 0, 0);
        wrap.addView(body, blp);

        TextView meta = Ui.meta(this, "You");
        LinearLayout.LayoutParams mlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        mlp.gravity = Gravity.END;
        mlp.topMargin = Ui.dp(this, 3);
        wrap.addView(meta, mlp);

        msgList.addView(wrap);
        scrollBottom();
        return body;
    }

    /** Holds the live assistant bubble and its zones. */
    private static final class AssistantBubble {
        LinearLayout wrap;
        LinearLayout toolZone;
        TextView content;
        TextView waiting;
        TextView meta;
        boolean hasContent = false;
    }

    private AssistantBubble addAssistantBubble() {
        clearEmpty();
        AssistantBubble b = new AssistantBubble();
        b.wrap = new LinearLayout(this);
        b.wrap.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Ui.dp(this, 10);
        b.wrap.setLayoutParams(lp);

        /* The answer zone. Created empty; filled as content streams. */
        b.content = Ui.tv(this, "", 15, Ui.PRIMARY);
        b.content.setBackgroundResource(R.drawable.bg_bubble_in);
        b.content.setPadding(Ui.dp(this, 14), Ui.dp(this, 10), Ui.dp(this, 14), Ui.dp(this, 10));
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        clp.gravity = Gravity.START;
        int side = Ui.dp(this, 40);
        clp.setMargins(0, 0, side, 0);
        b.content.setVisibility(View.GONE);   // only appears when real content arrives
        b.wrap.addView(b.content, clp);

        /* Tool activity zone, below the answer. */
        b.toolZone = new LinearLayout(this);
        b.toolZone.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams tz = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tz.topMargin = Ui.dp(this, 6);
        b.wrap.addView(b.toolZone, tz);

        /* Waiting dot -- shown until the first real token, then removed. */
        b.waiting = Ui.tv(this, "Aether is thinking…", 12, Ui.DIM);
        LinearLayout.LayoutParams wl = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        wl.topMargin = Ui.dp(this, 6);
        b.wrap.addView(b.waiting, wl);

        b.meta = Ui.meta(this, "");
        b.meta.setVisibility(View.GONE);
        LinearLayout.LayoutParams ml = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ml.topMargin = Ui.dp(this, 3);
        b.wrap.addView(b.meta, ml);

        msgList.addView(b.wrap);
        scrollBottom();
        return b;
    }

    private void onThinking(AssistantBubble b, String text) {
        boolean tool = text.contains("🛠") || text.contains("↳") || text.contains("web_search")
                || text.contains("run_command") || text.contains("fetch_page") || text.contains("crawl");
        TextView row;
        if (tool) {
            row = Ui.tv(this, text, 12, Ui.ACCENT);
            row.setTypeface(Ui.mono(this));
            row.setBackgroundResource(R.drawable.bg_tool);
            row.setPadding(Ui.dp(this, 10), Ui.dp(this, 6), Ui.dp(this, 10), Ui.dp(this, 6));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.topMargin = Ui.dp(this, 4);
            b.toolZone.addView(row, lp);
        } else {
            row = Ui.tv(this, text, 12, Ui.DIM);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.topMargin = Ui.dp(this, 2);
            b.toolZone.addView(row, lp);
        }
        scrollBottom();
    }

    private void onContent(AssistantBubble b, String text) {
        if (b.waiting != null && b.waiting.getParent() != null) {
            b.wrap.removeView(b.waiting);
            b.waiting = null;
        }
        if (!b.hasContent) {
            b.content.setVisibility(View.VISIBLE);
            b.hasContent = true;
        }
        b.content.append(text);
        scrollBottom();
    }

    private void onError(String text, String prompt) {
        TextView row = Ui.tv(this, text, 13, Ui.ERROR);
        row.setBackgroundResource(R.drawable.bg_card);
        row.setPadding(Ui.dp(this, 12), Ui.dp(this, 10), Ui.dp(this, 12), Ui.dp(this, 10));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Ui.dp(this, 10);
        msgList.addView(row, lp);

        TextView retry = new TextView(this);
        retry.setText("Try again");
        retry.setTextColor(getColor(R.color.aether_accent));
        retry.setTextSize(13);
        LinearLayout.LayoutParams rl = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rl.topMargin = Ui.dp(this, 6);
        retry.setPadding(Ui.dp(this, 8), Ui.dp(this, 4), Ui.dp(this, 8), Ui.dp(this, 4));
        retry.setOnClickListener(v -> {
            msgList.removeView(retry);
            msgList.removeView(row);
            send(prompt);
        });
        msgList.addView(retry, rl);
        scrollBottom();
    }

    private void showErrorGlobal(String text) {
        msgList.removeAllViews();
        msgList.addView(Ui.centered(this, text, 14, Ui.ERROR));
    }

    // ----------------------------------------------------------------- send

    private void onSend() {
        String text = input.getText().toString().trim();
        if (text.isEmpty() || cancelFlag != null) return;
        input.setText("");
        hideKeyboard();
        send(text);
    }

    private void hideKeyboard() {
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(input.getWindowToken(), 0);
    }

    private void send(String prompt) {
        addUserBubble(prompt);
        final AssistantBubble b = addAssistantBubble();
        setStreaming(true);

        bg.execute(() -> {
            /* Resolve an engine on a real poll, not a guess. */
            List<EngineRouter.SlotState> states = pollStates();
            EngineRouter.Decision d = EngineRouter.route(mode(), states);

            if (!d.ok()) {
                /* Nothing live: wake the routed candidate rather than failing. */
                String slot = mode().equals(EngineRouter.AUTO) ? "a" : mode();
                EngineCore.Engine e = cfg.bySlot(slot);
                if (e == null) {
                    ui.post(() -> { setStreaming(false); onError("No engines are configured.", prompt); });
                    return;
                }
                ui.post(() -> onThinking(b, "Engine " + e.slot.toUpperCase()
                        + " is off -- waking it now. This takes a few minutes; your message will send once it is live."));
                try {
                    EngineCore.kernelPush(e, Credentials.renderNotebook(
                            Credentials.notebookTemplate(ChatActivity.this), cfg, e.slot),
                            EngineCore.KERNEL_TITLE, true, 120_000);
                } catch (Exception ex) {
                    ui.post(() -> { setStreaming(false);
                        onError("Could not wake engine " + e.slot.toUpperCase() + ": "
                                + ex.getMessage(), prompt); });
                    return;
                }
                /* Wait for it to become live, then stream. */
                String url = null;
                for (int i = 0; i < 150 && url == null; i++) {
                    try { Thread.sleep(4000); } catch (InterruptedException ie) { return; }
                    try {
                        url = EngineCore.currentLinkFor(cfg.beaconTopic, cfg.beaconSecret,
                                e.slot, 20 * 60, 20_000);
                    } catch (Exception ignored) { }
                    ui.post(this::refreshChip);
                }
                if (url == null) {
                    ui.post(() -> { setStreaming(false);
                        onError("Engine " + e.slot.toUpperCase()
                                + " did not come live in time. Try again shortly.", prompt); });
                    return;
                }
                stream(url, prompt, b);
                return;
            }

            stream(d.url, prompt, b);
        });
    }

    private void stream(String url, String prompt, AssistantBubble b) {
        cancelFlag = new boolean[] {false};
        final long t0 = System.currentTimeMillis();
        final StringBuilder out = new StringBuilder();
        EngineCore.chatStream(url, cfg.offKey, prompt, "", cancelFlag,
                new EngineCore.ChatListener() {
                    @Override public void onThinking(String t) {
                        ui.post(() -> onThinking(b, t));
                    }
                    @Override public void onContent(String t) {
                        out.append(t);
                        ui.post(() -> onContent(b, t));
                    }
                    @Override public void onDone(boolean ok, String err) {
                        ui.post(() -> {
                            setStreaming(false);
                            cancelFlag = null;
                            long ms = System.currentTimeMillis() - t0;
                            if (!ok && err != null && err.equals("cancelled")) {
                                b.meta.setText("stopped after " + (ms / 1000) + "s");
                                b.meta.setVisibility(View.VISIBLE);
                            } else if (!ok) {
                                onError("Engine error: " + err, prompt);
                            } else {
                                b.meta.setText("Aether · " + (ms / 1000) + "s");
                                b.meta.setVisibility(View.VISIBLE);
                            }
                            refreshChip();
                        });
                    }
                }, 600_000);
    }

    private void setStreaming(boolean streaming) {
        sendBtn.setVisibility(streaming ? View.GONE : View.VISIBLE);
        stopBtn.setVisibility(streaming ? View.VISIBLE : View.GONE);
        input.setEnabled(!streaming);
    }
}
