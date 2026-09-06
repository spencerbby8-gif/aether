package com.aether.app;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.drawerlayout.widget.DrawerLayout;

import com.aether.app.core.Attachment;
import com.aether.app.core.ChatMessage;
import com.aether.app.core.ChatSession;
import com.aether.app.core.ChatStore;
import com.aether.app.core.TextNormalizer;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The primary screen: a chat-first conversation with Aether, plus the history
 * drawer beside it.
 *
 * Engine selection, wake and shutdown live in Settings, not here -- the main
 * screen stays focused on the conversation. The header chip is the only engine
 * surface, and it is a read-only status that deep-links to Settings.
 *
 * HISTORY. Every conversation is a JSON transcript in app-private storage
 * (ChatStore): open one from the drawer, start a new one, rename it, delete it.
 * A turn is written when it finishes, and again on pause, so nothing is lost by
 * a backgrounded app.
 *
 * STREAMING. The assistant bubble is built in three zones that fill only when
 * the engine emits the matching event:
 *
 *   thinking  -- dim rows, from {"message":{"thinking":...}}
 *   tools     -- accent monospace tiles, from thinking lines that are actual
 *                tool calls ("web_search(...)", "... returned N chars")
 *   content   -- the answer, appended token as it arrives
 *
 * Nothing here is a looping placeholder: a thinking or tool row exists only
 * because the engine sent it, and the "waiting" line disappears the moment the
 * first real token lands.
 *
 * NORMALISATION. Raw model output goes through TextNormalizer before it is
 * displayed or stored: ANSI escapes, zero-width and bidi characters, emoji and
 * pictographs, stray control bytes and markdown decoration are removed, while
 * arrows, box drawing and code-block contents are preserved.
 *
 * CANCELLATION. The send button becomes a stop button while a turn is in flight;
 * stop flips the same flag EngineCore polls between NDJSON lines, so the socket
 * closes instead of letting the generation finish in the background.
 */
public class ChatActivity extends AppCompatActivity {

    /** Files larger than this are attached but not read into the prompt. */
    private static final int INLINE_MAX_BYTES = 200_000;
    /** Never read more than this off a content URI, whatever it claims. */
    private static final int READ_MAX_BYTES = 8 * 1024 * 1024;
    /** Minimum gap between re-normalising the growing answer. */
    private static final long RENDER_THROTTLE_MS = 70;

    private DrawerLayout drawer;
    private LinearLayout msgList;
    private ScrollView scroll;
    private EditText input;
    private ImageButton sendBtn;
    private ImageButton stopBtn;
    private TextView chip;
    private TextView headerSub;
    private View emptyView;
    private LinearLayout sessionList;
    private LinearLayout attachRow;

    private Credentials.Config cfg;
    private ChatStore store;
    private ChatSession current;

    /** Attachments staged for the next send. */
    private final List<Attachment> staged = new ArrayList<>();

    /** Chat thread: streaming, polling, file reads. */
    private final ExecutorService bg = Executors.newSingleThreadExecutor();
    /** Separate thread for the header chip, so a long wake never starves it. */
    private final ExecutorService pollExec = Executors.newSingleThreadExecutor();
    /**
     * Separate thread for storage. Saves and drawer reads must never queue
     * behind a ten-minute wake-and-wait on the chat thread, or a transcript
     * would appear not to save while an engine was booting.
     */
    private final ExecutorService storeExec = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());

    /** Cancel flag for the in-flight turn. Polled by EngineCore between lines. */
    private boolean[] cancelFlag = null;

    /**
     * The engine that answered last. Consecutive messages reuse it instead of
     * paying for a fresh beacon fetch and health check every single time, which
     * is what made the second message in a row feel slow. It is re-resolved on
     * any failure, so a stale URL cannot wedge the conversation.
     */
    private volatile String cachedUrl;
    private volatile String cachedSlot;
    private volatile long cachedAt;
    private static final long URL_FRESH_MS = 45_000;

    /** Ticking elapsed time for the live turn, so a long turn is visibly alive. */
    private AssistantBubble liveBubble;
    private long turnStart;

    private final List<EngineRouter.SlotState> lastStates = new ArrayList<>();

    private ActivityResultLauncher<String> pickFile;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_chat);

        drawer = findViewById(R.id.drawer);
        msgList = findViewById(R.id.msg_list);
        scroll = findViewById(R.id.chat_scroll);
        input = findViewById(R.id.input);
        sendBtn = findViewById(R.id.send_btn);
        stopBtn = findViewById(R.id.stop_btn);
        chip = findViewById(R.id.engine_chip);
        headerSub = findViewById(R.id.header_sub);
        sessionList = findViewById(R.id.session_list);
        attachRow = findViewById(R.id.attach_row);

        pickFile = registerForActivityResult(new ActivityResultContracts.GetContent(),
                uri -> { if (uri != null) ingest(uri); });

        store = new ChatStore(new java.io.File(getFilesDir(), "chats"));

        cfg = Credentials.load(this);
        if (cfg == null || cfg.engines.isEmpty()) {
            showErrorGlobal("This build has no engine credentials baked in.");
            return;
        }
        headerSub.setText("chat, tools, search, commands");

        chip.setOnClickListener(v -> openSettings());
        findViewById(R.id.settings_btn).setOnClickListener(v -> openSettings());
        findViewById(R.id.menu_btn).setOnClickListener(v -> {
            refreshDrawer();
            drawer.openDrawer(Gravity.START);
        });
        findViewById(R.id.new_chat_btn).setOnClickListener(v -> newChat());
        findViewById(R.id.attach_btn).setOnClickListener(v -> pickFile.launch("*/*"));

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

    @Override
    protected void onPause() {
        super.onPause();
        /* Persist whatever is on screen, including a turn that was cut short. */
        if (current != null && current.messageCount() > 0) persist();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        bg.shutdownNow();
        pollExec.shutdownNow();
        storeExec.shutdownNow();
    }

    private void openSettings() {
        startActivity(new Intent(this, SettingsActivity.class));
    }

    // ----------------------------------------------------------- status chip

    private void refreshChip() {
        pollExec.execute(() -> {
            if (cfg == null) return;
            List<EngineRouter.SlotState> states = pollStates();
            EngineRouter.Decision d = EngineRouter.route(mode(), states);
            ui.post(() -> {
                synchronized (lastStates) { lastStates.clear(); lastStates.addAll(states); }
                if (d.ok()) {
                    chip.setText("● " + d.slot.toUpperCase()
                            + (EngineRouter.isAuto(mode()) ? " · auto" : ""));
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

    // --------------------------------------------------------------- history

    private void refreshDrawer() {
        storeExec.execute(() -> {
            final List<ChatStore.Meta> metas = store.list();
            ui.post(() -> buildDrawer(metas));
        });
    }

    private void buildDrawer(List<ChatStore.Meta> metas) {
        sessionList.removeAllViews();
        if (metas.isEmpty()) {
            sessionList.addView(Ui.centered(this, getString(R.string.no_chats_yet), 13, Ui.DIM));
            return;
        }
        for (final ChatStore.Meta m : metas) {
            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setBackgroundResource(R.drawable.bg_card);
            card.setPadding(Ui.dp(this, 12), Ui.dp(this, 10), Ui.dp(this, 6), Ui.dp(this, 10));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.topMargin = Ui.dp(this, 6);
            card.setLayoutParams(lp);

            LinearLayout head = new LinearLayout(this);
            head.setOrientation(LinearLayout.HORIZONTAL);
            head.setGravity(Gravity.CENTER_VERTICAL);
            TextView title = Ui.tv(this, m.title, 14,
                    current != null && current.id.equals(m.id) ? Ui.ACCENT : Ui.PRIMARY);
            title.setMaxLines(1);
            title.setEllipsize(android.text.TextUtils.TruncateAt.END);
            head.addView(title, new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

            ImageView more = new ImageView(this);
            more.setImageResource(R.drawable.ic_more);
            more.setPadding(Ui.dp(this, 8), Ui.dp(this, 8), Ui.dp(this, 8), Ui.dp(this, 8));
            more.setContentDescription(getString(R.string.rename_chat));
            more.setOnClickListener(v -> sessionMenu(v, m.id, m.title));
            head.addView(more, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            card.addView(head);

            String meta = when(m.updatedAt) + " · " + m.messageCount + " msg"
                    + (m.messageCount == 1 ? "" : "s")
                    + (m.engine != null ? " · engine " + m.engine.toUpperCase(Locale.ROOT) : "");
            card.addView(Ui.meta(this, meta));

            card.setOnClickListener(v -> openChat(m.id));
            card.setOnLongClickListener(v -> { sessionMenu(v, m.id, m.title); return true; });
            sessionList.addView(card);
        }
    }

    private void sessionMenu(View anchor, final String id, final String title) {
        PopupMenu menu = new PopupMenu(this, anchor);
        menu.getMenu().add(0, 1, 0, getString(R.string.rename_chat));
        menu.getMenu().add(0, 2, 1, getString(R.string.delete_chat));
        menu.setOnMenuItemClickListener(item -> {
            if (item.getItemId() == 1) { promptRename(id, title); return true; }
            if (item.getItemId() == 2) { confirmDelete(id, title); return true; }
            return false;
        });
        menu.show();
    }

    private void promptRename(final String id, String currentTitle) {
        final EditText field = new EditText(this);
        field.setText(currentTitle);
        field.setHint(R.string.chat_title_hint);
        field.setSingleLine(true);
        field.setSelectAllOnFocus(true);
        new AlertDialog.Builder(this)
                .setTitle(R.string.rename_chat)
                .setView(field)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.rename_chat, (d, w) -> {
                    storeExec.execute(() -> {
                        final boolean ok = store.rename(id, field.getText().toString());
                        ui.post(() -> {
                            if (ok) {
                                if (current != null && current.id.equals(id)) {
                                    current.title = store.load(id) != null
                                            ? store.load(id).title : current.title;
                                    current.titleLocked = true;
                                }
                                refreshDrawer();
                            } else {
                                toast("Could not rename that chat.");
                            }
                        });
                    });
                })
                .show();
    }

    private void confirmDelete(final String id, String title) {
        new AlertDialog.Builder(this)
                .setTitle(R.string.delete_confirm_title)
                .setMessage(getString(R.string.delete_confirm_message) + "\n\n" + title)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.delete_chat, (d, w) -> {
                    storeExec.execute(() -> {
                        final boolean ok = store.delete(id);
                        ui.post(() -> {
                            if (ok && current != null && current.id.equals(id)) {
                                current = null;
                                msgList.removeAllViews();
                                showEmptyState();
                            }
                            if (ok) toast("Chat deleted.");
                            refreshDrawer();
                        });
                    });
                })
                .show();
    }

    private void openChat(final String id) {
        drawer.closeDrawer(Gravity.START);
        storeExec.execute(() -> {
            final ChatSession s = store.load(id);
            ui.post(() -> {
                if (s == null) { toast("That chat could not be read."); return; }
                current = s;
                headerSub.setText(s.title);
                renderSession(s);
            });
        });
    }

    private void newChat() {
        drawer.closeDrawer(Gravity.START);
        if (current != null && current.messageCount() > 0) persist();
        current = null;
        staged.clear();
        renderStaged();
        msgList.removeAllViews();
        headerSub.setText("chat, tools, search, commands");
        showEmptyState();
        input.requestFocus();
    }

    /** Rebuild the message list from a stored transcript. */
    private void renderSession(ChatSession s) {
        msgList.removeAllViews();
        if (s.messages.isEmpty()) { showEmptyState(); return; }
        for (ChatMessage m : s.messages) {
            if (m.isUser()) {
                TextView body = addUserBubble(m.content);
                if (m.attachments != null && !m.attachments.isEmpty()) addAttachmentChips(body, m.attachments);
                attachMessageActions(body, m);
            } else {
                AssistantBubble b = addAssistantBubble();
                for (String line : m.toolLines) pushThinking(b, line);
                if (m.content != null && !m.content.isEmpty()) {
                    b.raw.append(m.content);
                    showNormalized(b, true);
                } else if (b.waiting != null && b.waiting.getParent() != null) {
                    /* A finished turn with no answer must not still say "thinking". */
                    b.wrap.removeView(b.waiting);
                    b.waiting = null;
                }
                if (ChatMessage.STATUS_ERROR.equals(m.status)) {
                    b.meta.setText("error" + (m.note != null ? " — " + m.note : ""));
                    b.meta.setTextColor(getColor(R.color.aether_error));
                    b.meta.setVisibility(View.VISIBLE);
                } else if (ChatMessage.STATUS_STOPPED.equals(m.status)) {
                    b.meta.setText("stopped" + (m.note != null ? " — " + m.note : ""));
                    b.meta.setVisibility(View.VISIBLE);
                } else if (m.engine != null || !m.toolLines.isEmpty()) {
                    b.meta.setText((m.engine != null ? "engine " + m.engine.toUpperCase(Locale.ROOT) : "Aether"));
                    b.meta.setVisibility(View.VISIBLE);
                }
                if (b.content != null) attachMessageActions(b.content, m);
            }
        }
        scrollBottom();
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

    /** Attachment chips under a user bubble, so history shows what was sent. */
    private void addAttachmentChips(TextView anchor, List<Attachment> attachments) {
        ViewGroup parent = (ViewGroup) anchor.getParent();
        if (parent == null) return;
        int index = parent.indexOfChild(anchor);
        for (Attachment a : attachments) {
            TextView chipView = Ui.tv(this, attachmentLabel(a), 11,
                    a.sentToEngine ? Ui.ACCENT : Ui.DIM);
            chipView.setBackgroundResource(R.drawable.bg_tool);
            chipView.setPadding(Ui.dp(this, 10), Ui.dp(this, 5), Ui.dp(this, 10), Ui.dp(this, 5));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.gravity = Gravity.END;
            lp.topMargin = Ui.dp(this, 4);
            parent.addView(chipView, index + 1, lp);
            index++;
        }
    }

    private String attachmentLabel(Attachment a) {
        String size = a.size < 1024 ? a.size + " B"
                : a.size < 1024 * 1024 ? (a.size / 1024) + " KB"
                : String.format(Locale.US, "%.1f MB", a.size / (1024.0 * 1024.0));
        String state = a.sentToEngine ? getString(R.string.attachment_inline)
                : getString(R.string.attachment_not_sent);
        return a.name + " · " + size + " · " + state;
    }

    /** Long-press a message for copy and retry. */
    private void attachMessageActions(final View anchor, final ChatMessage m) {
        anchor.setOnLongClickListener(v -> {
            PopupMenu menu = new PopupMenu(this, anchor);
            menu.getMenu().add(0, 1, 0, getString(R.string.copy));
            menu.getMenu().add(0, 2, 1, getString(R.string.retry_message));
            menu.setOnMenuItemClickListener(item -> {
                if (item.getItemId() == 1) { copy(m.content); return true; }
                if (item.getItemId() == 2) { retryOf(m); return true; }
                return false;
            });
            menu.show();
            return true;
        });
    }

    private void copy(String text) {
        ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (cm == null || text == null) return;
        cm.setPrimaryClip(ClipData.newPlainText("Aether", text));
        toast(getString(R.string.copied));
    }

    /** Re-send the prompt this message belongs to. */
    private void retryOf(ChatMessage m) {
        if (cancelFlag != null) { toast("Wait for the current reply to stop first."); return; }
        String prompt;
        if (current == null) {
            prompt = m.isUser() ? m.content : null;
        } else if (m.isUser()) {
            prompt = m.content;
        } else {
            prompt = current.userPromptBefore(current.messages.indexOf(m));
        }
        if (prompt == null || prompt.isEmpty()) { toast("Nothing to retry."); return; }
        send(prompt, null);
    }

    /** Holds the live assistant bubble and its zones. */
    private static final class AssistantBubble {
        LinearLayout wrap;
        LinearLayout toolZone;
        TextView content;
        TextView waiting;
        TextView meta;
        boolean hasContent = false;
        /** Raw text exactly as the engine sent it. */
        final StringBuilder raw = new StringBuilder();
        long lastRender = 0L;
        /** Model message this bubble is filling, so it can be persisted. */
        ChatMessage model;
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

        /* Waiting line -- shown until the first real token, then removed. */
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

    /** A stored or streamed thinking line: is it a tool call rather than prose? */
    private static boolean isToolLine(String text) {
        if (text == null) return false;
        return text.startsWith("»")
                || text.contains("🛠") || text.contains("↳")
                || text.contains("web_search") || text.contains("run_command")
                || text.contains("fetch_page") || text.contains("crawl");
    }

    private void pushThinking(AssistantBubble b, String raw) {
        /* Any real event ends the waiting line, not just the first content
           token. During a tool-heavy turn the engine can send thinking and
           heartbeat lines for minutes before any answer text, and leaving
           "Aether is thinking…" up through all of it reads as a hang. */
        if (b.waiting != null && b.waiting.getParent() != null) {
            b.wrap.removeView(b.waiting);
            b.waiting = null;
        }
        boolean tool = isToolLine(raw);
        String text = TextNormalizer.normalize(raw);
        if (text.startsWith("»")) text = text.substring(1).trim();
        if (text.isEmpty()) return;
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

    /** Show the normalised answer. Throttled so long replies stay smooth. */
    private void showNormalized(AssistantBubble b, boolean force) {
        long now = System.currentTimeMillis();
        if (!force && now - b.lastRender < RENDER_THROTTLE_MS) return;
        b.lastRender = now;
        String clean = TextNormalizer.normalize(b.raw.toString());
        if (clean.isEmpty()) return;
        if (b.waiting != null && b.waiting.getParent() != null) {
            b.wrap.removeView(b.waiting);
            b.waiting = null;
        }
        if (!b.hasContent) {
            b.content.setVisibility(View.VISIBLE);
            b.hasContent = true;
        }
        b.content.setText(clean);
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
        retry.setText(getString(R.string.retry));
        retry.setTextColor(getColor(R.color.aether_accent));
        retry.setTextSize(13);
        LinearLayout.LayoutParams rl = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rl.topMargin = Ui.dp(this, 6);
        retry.setPadding(Ui.dp(this, 8), Ui.dp(this, 4), Ui.dp(this, 8), Ui.dp(this, 4));
        retry.setOnClickListener(v -> {
            msgList.removeView(retry);
            msgList.removeView(row);
            send(prompt, null);
        });
        msgList.addView(retry, rl);
        scrollBottom();
    }

    private void showErrorGlobal(String text) {
        msgList.removeAllViews();
        msgList.addView(Ui.centered(this, text, 14, Ui.ERROR));
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    }

    private static String when(long ts) {
        long age = System.currentTimeMillis() - ts;
        if (age < 60_000) return "just now";
        if (age < 3_600_000) return (age / 60_000) + "m ago";
        if (age < 86_400_000) return (age / 3_600_000) + "h ago";
        if (age < 7 * 86_400_000L) return (age / 86_400_000L) + "d ago";
        return new SimpleDateFormat("d MMM", Locale.US).format(new Date(ts));
    }

    // ------------------------------------------------------------ attaching

    /** Read a picked file off the content resolver, on the background thread. */
    private void ingest(final Uri uri) {
        storeExec.execute(() -> {
            String name = "file";
            String mime = "application/octet-stream";
            long declared = -1;
            Cursor c = null;
            try {
                String t = getContentResolver().getType(uri);
                if (t != null) mime = t;
                c = getContentResolver().query(uri, null, null, null, null);
                if (c != null && c.moveToFirst()) {
                    int n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (n >= 0 && !c.isNull(n)) name = c.getString(n);
                    int s = c.getColumnIndex(OpenableColumns.SIZE);
                    if (s >= 0 && !c.isNull(s)) declared = c.getLong(s);
                }
            } catch (Exception ignored) {
            } finally {
                if (c != null) c.close();
            }

            byte[] bytes = null;
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                if (in != null) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] buf = new byte[16 * 1024];
                    int r;
                    while ((r = in.read(buf)) > 0) {
                        out.write(buf, 0, r);
                        if (out.size() > READ_MAX_BYTES) break;
                    }
                    bytes = out.toByteArray();
                }
            } catch (Exception e) {
                final String err = e.getMessage();
                ui.post(() -> toast("Could not read that file: " + err));
                return;
            }
            if (bytes == null || bytes.length == 0) {
                ui.post(() -> toast("That file is empty."));
                return;
            }

            final String fname = name;
            final String fmime = mime;
            final byte[] fbytes = bytes;
            final long size = declared > 0 ? declared : bytes.length;
            ui.post(() -> stageAttachment(fname, fmime, size, fbytes));
        });
    }

    private void stageAttachment(String name, String mime, long size, byte[] bytes) {
        /* A transcript to attach to must exist before anything is stored. */
        if (current == null) current = store.create(null);

        String text = null;
        boolean inline = false;
        if (size > INLINE_MAX_BYTES) {
            text = null;
        } else if (isTextual(mime, name)) {
            text = TextNormalizer.userInput(new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
            inline = true;
        }

        java.io.File stored = store.storeAttachment(current.id, bytes, name);
        Attachment a = new Attachment(
                stored != null ? stored.getName() : ChatStore.newId(),
                name, size, mime, text, inline);
        staged.add(a);
        renderStaged();
    }

    private static boolean isTextual(String mime, String name) {
        if (mime != null && (mime.startsWith("text/") || mime.contains("json")
                || mime.contains("xml") || mime.contains("javascript")
                || mime.contains("yaml") || mime.contains("csv"))) return true;
        String lower = name == null ? "" : name.toLowerCase(Locale.ROOT);
        String[] exts = {".txt", ".md", ".json", ".csv", ".log", ".py", ".js", ".ts", ".tsx",
                ".java", ".kt", ".xml", ".yaml", ".yml", ".sh", ".sql", ".html", ".css", ".ini",
                ".toml", ".conf", ".c", ".h", ".cpp", ".rs", ".go", ".rb", ".php"};
        for (String e : exts) if (lower.endsWith(e)) return true;
        return false;
    }

    private void renderStaged() {
        attachRow.removeAllViews();
        attachRow.setVisibility(staged.isEmpty() ? View.GONE : View.VISIBLE);
        for (int i = 0; i < staged.size(); i++) {
            final int index = i;
            final Attachment a = staged.get(i);
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setBackgroundResource(R.drawable.bg_card);
            row.setPadding(Ui.dp(this, 10), Ui.dp(this, 7), Ui.dp(this, 4), Ui.dp(this, 7));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.topMargin = Ui.dp(this, 4);

            TextView label = Ui.tv(this, attachmentLabel(a), 11,
                    a.sentToEngine ? Ui.PRIMARY : Ui.DIM);
            label.setMaxLines(2);
            row.addView(label, new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

            TextView x = new TextView(this);
            x.setText("×");
            x.setTextSize(16);
            x.setTextColor(getColor(R.color.aether_muted));
            x.setPadding(Ui.dp(this, 10), Ui.dp(this, 2), Ui.dp(this, 10), Ui.dp(this, 2));
            x.setContentDescription(getString(R.string.attachment_removed));
            x.setOnClickListener(v -> {
                if (index < staged.size()) {
                    staged.remove(index);
                    renderStaged();
                }
            });
            row.addView(x);
            attachRow.addView(row, lp);
        }
    }

    // ----------------------------------------------------------------- send

    private void onSend() {
        String text = TextNormalizer.userInput(input.getText().toString());
        if ((text.isEmpty() && staged.isEmpty()) || cancelFlag != null) return;
        input.setText("");
        hideKeyboard();
        List<Attachment> going = new ArrayList<>(staged);
        staged.clear();
        renderStaged();
        send(text, going);
    }

    private void hideKeyboard() {
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(input.getWindowToken(), 0);
    }

    /**
     * Send a turn. `attachments` is null for a retry, which re-sends a prompt
     * that already carries whatever it carried the first time.
     */
    private void send(final String prompt, final List<Attachment> attachments) {
        if (current == null) current = store.create(prompt);
        if (!current.titleLocked && ("New chat".equals(current.title) || current.title == null
                || current.title.isEmpty())) {
            current.rename(TextNormalizer.title(prompt, 42));
            current.titleLocked = false;      // still open to a later rename
            headerSub.setText(current.title);
        }

        /* Record what the user sent, attachments and all. */
        ChatMessage userMsg = new ChatMessage(ChatMessage.ROLE_USER);
        userMsg.content = prompt;
        if (attachments != null) userMsg.attachments.addAll(attachments);
        current.messages.add(userMsg);

        TextView userBody = addUserBubble(prompt);
        if (attachments != null && !attachments.isEmpty()) {
            addAttachmentChips(userBody, attachments);
        }
        attachMessageActions(userBody, userMsg);

        final AssistantBubble b = addAssistantBubble();
        ChatMessage model = new ChatMessage(ChatMessage.ROLE_ASSISTANT);
        b.model = model;
        current.messages.add(model);
        attachMessageActions(b.content, model);

        liveBubble = b;
        turnStart = System.currentTimeMillis();
        setStreaming(true);
        persist();

        /* The prompt the engine sees: text plus any readable attachment. */
        final String wire = composeWire(prompt, attachments);

        bg.execute(() -> {
            /* Reuse the engine that just answered unless it has gone stale. */
            EngineRouter.Decision d = cachedDecision();
            if (d == null) d = EngineRouter.route(mode(), pollStates());

            if (!d.ok()) {
                /* Nothing live: wake the routed candidate rather than failing. */
                String slot = EngineRouter.isAuto(mode()) ? "a" : EngineRouter.canonical(mode());
                EngineCore.Engine e = cfg.bySlot(slot);
                if (e == null) {
                    ui.post(() -> { setStreaming(false); markError(model, "no engines configured");
                        onError("No engines are configured.", prompt); persist(); });
                    return;
                }
                ui.post(() -> pushThinking(b, "Engine " + e.slot.toUpperCase()
                        + " is off -- waking it now. This takes a few minutes; your message will send once it is live."));
                try {
                    EngineCore.kernelPush(e, Credentials.renderNotebook(
                            Credentials.notebookTemplate(ChatActivity.this), cfg, e.slot),
                            EngineCore.KERNEL_TITLE, true, 120_000);
                } catch (Exception ex) {
                    ui.post(() -> { setStreaming(false);
                        markError(model, ex.getMessage());
                        onError("Could not wake engine " + e.slot.toUpperCase() + ": "
                                + ex.getMessage(), prompt); persist(); });
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
                        markError(model, "engine did not come live in time");
                        onError("Engine " + e.slot.toUpperCase()
                                + " did not come live in time. Try again shortly.", prompt); persist(); });
                    return;
                }
                model.engine = e.slot;
                remember(e.slot, url);
                streamWithFailover(url, wire, prompt, b, true);
                return;
            }

            model.engine = d.slot;
            remember(d.slot, d.url);
            streamWithFailover(d.url, wire, prompt, b, true);
        });
    }

    /** The cached engine, if it was live recently and the mode has not changed. */
    private EngineRouter.Decision cachedDecision() {
        String url = cachedUrl;
        String slot = cachedSlot;
        if (url == null || slot == null) return null;
        if (System.currentTimeMillis() - cachedAt > URL_FRESH_MS) return null;
        if (!EngineRouter.isAuto(mode()) && !slot.equals(EngineRouter.canonical(mode()))) {
            return null;      // the user pinned a different engine
        }
        return new EngineRouter.Decision(slot, url, "reused engine " + slot.toUpperCase(Locale.ROOT), false);
    }

    private void remember(String slot, String url) {
        cachedSlot = slot;
        cachedUrl = url;
        cachedAt = System.currentTimeMillis();
    }

    private void forget() {
        cachedUrl = null;
        cachedSlot = null;
        cachedAt = 0L;
    }

    /** The engine has no upload endpoint, so readable attachments ride in the prompt. */
    private String composeWire(String prompt, List<Attachment> attachments) {
        if (attachments == null || attachments.isEmpty()) return prompt;
        StringBuilder sb = new StringBuilder(prompt);
        for (Attachment a : attachments) {
            if (!a.hasText()) continue;
            sb.append("\n\n--- attached file: ").append(a.name)
              .append(" (").append(a.mime).append(", ").append(a.size).append(" bytes) ---\n")
              .append(a.text);
        }
        return sb.toString();
    }

    private void markError(ChatMessage m, String note) {
        m.status = ChatMessage.STATUS_ERROR;
        m.note = note == null ? "error" : note;
    }

    /**
     * Stream one turn, and if the engine lets go before answering, fail over
     * once and retry -- without ever leaving the bubble mid-generation.
     *
     * Runs on the background thread. The listener only RECORDS the outcome;
     * this method decides what the UI is told, because a dropped engine may be
     * retried on another slot rather than reported as an error.
     */
    private void streamWithFailover(final String url, final String wire, final String prompt,
                                    final AssistantBubble b, final boolean allowFailover) {
        final boolean[] cancel = new boolean[] {false};
        cancelFlag = cancel;
        final long t0 = System.currentTimeMillis();
        final boolean[] ok = new boolean[] {false};
        final String[] err = new String[] {null};
        final AtomicBoolean recorded = new AtomicBoolean(false);

        EngineCore.chatStream(url, cfg.offKey, wire, "", cancel,
                new EngineCore.ChatListener() {
                    @Override public void onThinking(String t) {
                        ui.post(() -> {
                            pushThinking(b, t);
                            if (b.model != null) {
                                b.model.toolLines.add(isToolLine(t)
                                        ? "\u00BB " + TextNormalizer.normalize(t)
                                        : TextNormalizer.normalize(t));
                            }
                        });
                    }
                    @Override public void onContent(String t) {
                        b.raw.append(t);
                        ui.post(() -> showNormalized(b, false));
                    }
                    @Override public void onDone(boolean good, String e) {
                        if (recorded.compareAndSet(false, true)) { ok[0] = good; err[0] = e; }
                    }
                }, EngineCore.StreamPolicy.standard());

        boolean userStopped = cancel[0];
        boolean cancelled = "cancelled".equals(err[0]);

        /* Nothing at all arrived and the engine let go on its own: the tunnel
           died or the kernel went away. Try the next engine in A -> B -> C
           rather than making the user press send again. */
        if (!ok[0] && !cancelled && !userStopped && allowFailover && b.raw.length() == 0) {
            final String from = cachedSlot == null ? "?" : cachedSlot;
            final String reason = err[0];
            EngineRouter.Decision next = EngineRouter.failoverFrom(from, pollStates());
            if (next.ok()) {
                ui.post(() -> pushThinking(b, "Engine " + from.toUpperCase(Locale.ROOT)
                        + " dropped (" + reason + ") -- failing over to "
                        + next.slot.toUpperCase(Locale.ROOT)));
                forget();
                remember(next.slot, next.url);
                if (b.model != null) b.model.engine = next.slot;
                streamWithFailover(next.url, wire, prompt, b, false);
                return;
            }
        }

        finalizeTurn(b, prompt, ok[0], err[0], System.currentTimeMillis() - t0);
    }

    /** Every turn ends here, exactly once, on the UI thread. */
    private void finalizeTurn(final AssistantBubble b, final String prompt,
                              final boolean ok, final String err, final long ms) {
        ui.post(() -> {
            setStreaming(false);
            cancelFlag = null;
            showNormalized(b, true);
            if (b.model != null) {
                b.model.content = TextNormalizer.normalize(b.raw.toString());
            }
            if (!ok && "cancelled".equals(err)) {
                if (b.model != null) {
                    b.model.status = ChatMessage.STATUS_STOPPED;
                    b.model.note = "stopped after " + (ms / 1000) + "s";
                }
                b.meta.setText("stopped after " + (ms / 1000) + "s");
                b.meta.setVisibility(View.VISIBLE);
            } else if (!ok) {
                forget();     // a failed engine must not be reused next message
                if (b.model != null) markError(b.model, err);
                onError("Engine error: " + err, prompt);
            } else {
                if (b.model != null) b.model.status = ChatMessage.STATUS_OK;
                String who = b.model != null && b.model.engine != null
                        ? "engine " + b.model.engine.toUpperCase(Locale.ROOT) : "Aether";
                b.meta.setText(who + " · " + (ms / 1000) + "s");
                b.meta.setVisibility(View.VISIBLE);
            }
            persist();
            refreshChip();
        });
    }

    /** Write the transcript, and keep the drawer in step with it. */
    private void persist() {
        if (current == null) return;
        final ChatSession s = current;
        storeExec.execute(() -> {
            store.save(s);
            ui.post(ChatActivity.this::refreshDrawer);
        });
    }

    private void setStreaming(boolean streaming) {
        sendBtn.setVisibility(streaming ? View.GONE : View.VISIBLE);
        stopBtn.setVisibility(streaming ? View.VISIBLE : View.GONE);
        input.setEnabled(!streaming);
        if (streaming) {
            ui.post(ticker);
        } else {
            ui.removeCallbacks(ticker);
            liveBubble = null;
        }
    }

    /**
     * One update a second while a turn is in flight: which engine, how long it
     * has been running. This is measured state, not decoration -- it is the
     * difference between "the app is working on it" and "the app froze".
     */
    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            AssistantBubble b = liveBubble;
            if (b == null || cancelFlag == null) return;
            long secs = (System.currentTimeMillis() - turnStart) / 1000;
            String who = b.model != null && b.model.engine != null
                    ? "engine " + b.model.engine.toUpperCase(Locale.ROOT) : "Aether";
            b.meta.setText(who + " · " + secs + "s · streaming…");
            b.meta.setVisibility(View.VISIBLE);
            ui.postDelayed(this, 1000);
        }
    };
}
