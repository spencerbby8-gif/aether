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
import android.view.animation.AlphaAnimation;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
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

import android.content.ContentValues;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import com.aether.app.core.AgentActivity;
import com.aether.app.core.AnswerBlocks;
import com.aether.app.core.Attachment;
import com.aether.app.core.ChatMessage;
import com.aether.app.core.ChatSession;
import com.aether.app.core.ChatStore;
import com.aether.app.core.MediaItem;
import com.aether.app.core.TaskRecord;
import com.aether.app.core.TaskTracker;
import com.aether.app.core.TextNormalizer;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashSet;
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
    /* Telemetry gets its own pool. A publish can block for its whole timeout,
       and queueing that behind the single-threaded store or poll executors is
       exactly how the buttons ended up dead behind the poll loop before. */
    private final ExecutorService telemExec = Executors.newCachedThreadPool();
    /* Media gets its own pool too: a download or an image decode is slow and
       must not queue behind the store or the poll loop, and two saves can run
       at once. */
    private final ExecutorService mediaExec = Executors.newCachedThreadPool();
    private boolean reportedFirstStream = false;
    private final Handler ui = new Handler(Looper.getMainLooper());

    /** Cancel flag for the in-flight turn. Polled by EngineCore between lines. */
    private boolean[] cancelFlag = null;
    /* The turn that is streaming right now. Stop has to break its read: the
       read timeout is deliberately longer than any silence the engine may
       produce, so a flag alone would not interrupt it. */
    private final EngineCore.TurnHandle turn = new EngineCore.TurnHandle();

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
            turn.cancel();
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
        mediaExec.shutdownNow();
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
                /* Stored lines are the engine's real operational events; the
                   model's reasoning was never saved, so a reloaded transcript
                   cannot resurrect it. finish() collapses the strip and stops
                   any animation before the message is even on screen. */
                for (String line : m.toolLines) b.activity.event(line);
                b.activity.report = m.taskReport;
                b.activity.finish();
                if (m.media != null && !m.media.isEmpty()) {
                    b.media.addAll(m.media);
                    renderMedia(b);
                }
                if (m.content != null && !m.content.isEmpty()) {
                    b.raw.append(m.content);
                    renderAnswer(b, true);
                    addSources(b);
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
                attachMessageActions(b.contentZone, m);
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

    /**
     * Follow the answer only while the reader is already at the bottom. Yanking
     * the list down under someone who scrolled up to re-read is the classic
     * streaming bug, and it gets worse the faster tokens arrive.
     */
    private void followIfAtBottom() {
        final View child = scroll.getChildAt(0);
        if (child == null) { scrollBottom(); return; }
        int gap = child.getBottom() - (scroll.getHeight() + scroll.getScrollY());
        if (gap < Ui.dp(this, 140)) scrollBottom();
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
        TextView notice;
        TextView meta;
        /** Answer zone: one text view while streaming, styled segments after. */
        LinearLayout contentZone;
        /** Real sources this turn used, rendered only when there are any. */
        LinearLayout sources;
        /** Images and voice clips the engine generated, with a save action. */
        LinearLayout mediaZone;
        final List<MediaItem> media = new ArrayList<>();
        /** Compact activity strip, driven only by real engine events. */
        ActivityPanel activity;
        boolean hasContent = false;
        /** Shape of the request sent, captured where it is in scope so the
            failure report can include it. Counts and roles only. */
        String reqShape = "";
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

        /* Activity first and compact: one line above the answer, never a log. */
        b.activity = new ActivityPanel();
        b.wrap.addView(b.activity.card);
        b.wrap.addView(b.activity.list);

        /* The answer zone -- the visual focus of the turn. */
        b.contentZone = new LinearLayout(this);
        b.contentZone.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams cz = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cz.topMargin = Ui.dp(this, 8);
        b.contentZone.setVisibility(View.GONE);      // appears with the first real token
        b.wrap.addView(b.contentZone, cz);

        b.content = Ui.tv(this, "", 15, Ui.PRIMARY);
        b.content.setBackgroundResource(R.drawable.bg_bubble_in);
        b.content.setPadding(Ui.dp(this, 14), Ui.dp(this, 11), Ui.dp(this, 14), Ui.dp(this, 11));
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        clp.gravity = Gravity.START;
        clp.setMargins(0, 0, Ui.dp(this, 40), 0);
        b.contentZone.addView(b.content, clp);

        /* Generated media, above the sources: a picture or a voice clip the
           user can open or save. Empty until the engine reports one. */
        b.mediaZone = new LinearLayout(this);
        b.mediaZone.setOrientation(LinearLayout.VERTICAL);
        b.mediaZone.setVisibility(View.GONE);
        LinearLayout.LayoutParams mz = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        mz.topMargin = Ui.dp(this, 8);
        b.wrap.addView(b.mediaZone, mz);

        /* App-level notices (an engine waking, for example). Not agent activity. */
        b.notice = Ui.tv(this, "", 12, Ui.DIM);
        b.notice.setVisibility(View.GONE);
        LinearLayout.LayoutParams nl = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        nl.topMargin = Ui.dp(this, 6);
        b.wrap.addView(b.notice, nl);

        /* Sources, only when the turn really used any. */
        b.sources = new LinearLayout(this);
        b.sources.setOrientation(LinearLayout.VERTICAL);
        b.sources.setVisibility(View.GONE);
        LinearLayout.LayoutParams sl = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        sl.topMargin = Ui.dp(this, 6);
        b.wrap.addView(b.sources, sl);

        b.meta = Ui.meta(this, "");
        b.meta.setVisibility(View.GONE);
        LinearLayout.LayoutParams ml = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ml.topMargin = Ui.dp(this, 4);
        b.wrap.addView(b.meta, ml);

        msgList.addView(b.wrap);
        scrollBottom();
        return b;
    }

    /**
     * The compact activity strip above an answer.
     *
     * One line while the turn runs, a summary when it ends, and expandable to
     * the steps the engine actually reported. Everything here is driven by real
     * events: {@link AgentActivity} rejects anything it does not recognise --
     * including the model's own reasoning, which the kernel streams as a
     * thinking event -- so the strip can only ever describe work that happened.
     *
     * The pulse is started when an event arrives and cancelled when the turn
     * ends, so a finished message never animates and a stuck turn never looks
     * idle.
     */
    private final class ActivityPanel {
        final LinearLayout card = new LinearLayout(ChatActivity.this);
        final LinearLayout list = new LinearLayout(ChatActivity.this);
        final View dot = new View(ChatActivity.this);
        final TextView label = Ui.tv(ChatActivity.this, "", 12, Ui.DIM);
        final TextView chevron = Ui.tv(ChatActivity.this, "", 10, Ui.DIM);
        final AgentActivity model = new AgentActivity();
        /** How the task ended. Rendered under the steps when expanded. */
        String report;
        private final AlphaAnimation pulse = new AlphaAnimation(1f, 0.22f);
        private boolean running;
        private boolean expanded;

        ActivityPanel() {
            card.setOrientation(LinearLayout.HORIZONTAL);
            card.setGravity(Gravity.CENTER_VERTICAL);
            card.setBackgroundResource(R.drawable.bg_pill_ghost);
            int px = Ui.dp(ChatActivity.this, 10), py = Ui.dp(ChatActivity.this, 6);
            card.setPadding(px, py, px, py);
            LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            clp.gravity = Gravity.START;
            card.setLayoutParams(clp);
            card.setVisibility(View.GONE);

            LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(
                    Ui.dp(ChatActivity.this, 7), Ui.dp(ChatActivity.this, 7));
            dlp.rightMargin = Ui.dp(ChatActivity.this, 7);
            dot.setBackgroundResource(R.drawable.bg_dot_accent);
            dot.setLayoutParams(dlp);
            card.addView(dot);
            card.addView(label, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            LinearLayout.LayoutParams chlp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            chlp.leftMargin = Ui.dp(ChatActivity.this, 6);
            card.addView(chevron, chlp);
            card.setOnClickListener(v -> toggle());

            list.setOrientation(LinearLayout.VERTICAL);
            list.setVisibility(View.GONE);
            LinearLayout.LayoutParams llp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            llp.topMargin = Ui.dp(ChatActivity.this, 4);
            list.setLayoutParams(llp);

            pulse.setDuration(760);
            pulse.setRepeatCount(AlphaAnimation.INFINITE);
            pulse.setRepeatMode(AlphaAnimation.REVERSE);
        }

        /** One raw engine event. Returns false when it must not be shown. */
        boolean event(String raw) {
            if (!model.feed(raw)) return false;
            running = true;
            card.setVisibility(View.VISIBLE);
            if (dot.getAnimation() == null) dot.startAnimation(pulse);
            render();
            return true;
        }

        void writing() { model.noteContent(); render(); }

        void finish() {
            model.finish();
            running = false;
            dot.clearAnimation();          // nothing may animate on a finished turn
            render();
        }

        void toggle() {
            if (!model.hasSteps()) return;
            expanded = !expanded;
            render();
        }

        private void render() {
            String text;
            if (running) {
                AgentActivity.Step open = model.open();
                text = open != null && !open.detail.isEmpty()
                        ? open.label + " \u00b7 " + open.detail : model.labelNow();
            } else {
                text = model.summary();
            }
            label.setText(text);
            label.setTextColor(getColor(running ? Ui.ACCENT : Ui.DIM));
            boolean detail = model.hasSteps() || (report != null && !report.isEmpty());
            chevron.setText(detail ? (expanded ? "\u25be" : "\u25b8") : "");
            chevron.setVisibility(detail ? View.VISIBLE : View.GONE);
            card.setVisibility(text.isEmpty() ? View.GONE : View.VISIBLE);
            boolean show = expanded && detail;
            list.setVisibility(show ? View.VISIBLE : View.GONE);
            if (show) renderList();
        }

        private void renderList() {
            list.removeAllViews();
            for (AgentActivity.Step st : model.steps()) {
                StringBuilder line = new StringBuilder(st.done ? "\u2713  " : "\u2022  ");
                line.append(st.label);
                if (!st.detail.isEmpty()) line.append(" \u00b7 ").append(st.detail);
                if (st.done && st.durationMs > 0) {
                    line.append(" \u00b7 ").append(st.durationMs < 1000
                            ? st.durationMs + "ms" : (st.durationMs / 1000) + "s");
                }
                TextView row = Ui.tv(ChatActivity.this, line.toString(), 11, Ui.DIM);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                lp.topMargin = Ui.dp(ChatActivity.this, 2);
                lp.leftMargin = Ui.dp(ChatActivity.this, 12);
                list.addView(row, lp);
            }
            /* How the task actually ended: what was done, what was verified,
               what failed and what is left. This is the report the user is owed
               at the end of a task, kept in the same collapsible strip as the
               steps so it never competes with the answer. */
            if (report != null && !report.isEmpty()) {
                for (String line : report.split("\n")) {
                    if (line.trim().isEmpty()) continue;
                    TextView rr = Ui.tv(ChatActivity.this, line.trim(), 11, Ui.DIM);
                    LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT);
                    rlp.topMargin = Ui.dp(ChatActivity.this, 2);
                    rlp.leftMargin = Ui.dp(ChatActivity.this, 12);
                    list.addView(rr, rlp);
                }
            }
        }
    }

    /** A notice from the app rather than the agent -- an engine waking, say. */
    private void pushNotice(AssistantBubble b, String text) {
        if (b.notice == null) return;
        b.notice.setText(text);
        b.notice.setVisibility(View.VISIBLE);
    }

    /**
     * Render the answer. The first real token is drawn immediately -- waiting
     * for a throttle tick on the first token is what makes a reply feel slow --
     * and later ones are throttled so a long reply stays smooth.
     */
    private void renderAnswer(AssistantBubble b, boolean force) {
        long now = System.currentTimeMillis();
        boolean first = !b.hasContent;
        if (!force && !first && now - b.lastRender < RENDER_THROTTLE_MS) return;
        b.lastRender = now;
        String clean = TextNormalizer.normalize(b.raw.toString());
        if (clean.isEmpty()) return;
        if (first) {
            b.hasContent = true;
            b.contentZone.setVisibility(View.VISIBLE);
            b.activity.writing();
        }
        /* While tokens arrive, one TextView is the cheapest thing that can be
           updated fourteen times a second. Fenced code is laid out once, when
           the turn ends: rebuilding a scroll view per token would stutter. */
        if (!force) {
            b.content.setVisibility(View.VISIBLE);
            b.content.setText(clean);
            followIfAtBottom();
            return;
        }
        /* Split the RAW text, not `clean`: TextNormalizer has already deleted
           the ``` fences by the time we get here, so splitting its output
           finds no code and every answer renders as flat prose. */
        List<AnswerBlocks.Block> blocks = AnswerBlocks.split(b.raw.toString());
        boolean anyCode = false;
        for (AnswerBlocks.Block bl : blocks) if (bl.code) { anyCode = true; break; }
        if (!anyCode) {
            b.content.setVisibility(View.VISIBLE);
            b.content.setText(clean);
        } else {
            b.content.setVisibility(View.GONE);
            b.contentZone.removeAllViews();
            LinearLayout cardv = new LinearLayout(this);
            cardv.setOrientation(LinearLayout.VERTICAL);
            cardv.setBackgroundResource(R.drawable.bg_bubble_in);
            cardv.setPadding(Ui.dp(this, 14), Ui.dp(this, 11), Ui.dp(this, 14), Ui.dp(this, 11));
            for (AnswerBlocks.Block bl : blocks) {
                cardv.addView(bl.code ? codeBlock(bl.text) : textBlock(bl.text));
            }
            LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            clp.gravity = Gravity.START;
            clp.setMargins(0, 0, Ui.dp(this, 40), 0);
            b.contentZone.addView(cardv, clp);
        }
        followIfAtBottom();
    }

    private View codeBlock(String code) {
        TextView t = Ui.tv(this, code, 12.5f, Ui.PRIMARY);
        t.setTypeface(Ui.mono(this));
        t.setPadding(Ui.dp(this, 12), Ui.dp(this, 10), Ui.dp(this, 12), Ui.dp(this, 10));
        t.setHorizontallyScrolling(true);        // code keeps its shape
        HorizontalScrollView hsv = new HorizontalScrollView(this);
        hsv.setBackgroundResource(R.drawable.bg_code);
        hsv.setHorizontalScrollBarEnabled(false);
        hsv.addView(t);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Ui.dp(this, 6);
        hsv.setLayoutParams(lp);
        return hsv;
    }

    private View textBlock(String text) {
        TextView t = Ui.tv(this, text, 15, Ui.PRIMARY);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Ui.dp(this, 4);
        t.setLayoutParams(lp);
        return t;
    }

    private static final java.util.regex.Pattern URL_RE =
            java.util.regex.Pattern.compile("https?://[^\\s)\\]>]+");

    /**
     * Compact source cards for the URLs this turn really touched: the ones the
     * engine fetched, plus any the answer cites. The host is shown, the full
     * link is kept and opens on tap -- the evidence survives, the plumbing
     * does not.
     */
    private void addSources(AssistantBubble b) {
        LinkedHashSet<String> urls = new LinkedHashSet<>(b.activity.model.sources());
        java.util.regex.Matcher m = URL_RE.matcher(b.raw.toString());
        while (m.find() && urls.size() < 6) urls.add(m.group());
        if (urls.isEmpty()) return;
        b.sources.removeAllViews();
        TextView head = Ui.tv(this, "Sources", 10, Ui.DIM);
        b.sources.addView(head);
        int n = 0;
        for (final String u : urls) {
            if (n++ >= 4) break;
            String host = AgentActivity.host(u);
            TextView row = Ui.tv(this, "\u2197  " + host, 11, Ui.ACCENT);
            row.setBackgroundResource(R.drawable.bg_source);
            row.setPadding(Ui.dp(this, 10), Ui.dp(this, 6), Ui.dp(this, 10), Ui.dp(this, 6));
            row.setOnClickListener(v -> {
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u))); }
                catch (Exception ignored) { }
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.topMargin = Ui.dp(this, 4);
            b.sources.addView(row, lp);
        }
        b.sources.setVisibility(View.VISIBLE);
    }

    // ------------------------------------------------- generated media

    /**
     * Render the images and voice clips the engine produced this turn.
     *
     * Each one gets its own card with a save action, because a URL in the
     * transcript is not something a phone user can keep: the tunnel that
     * served it goes away when the engine shuts down.
     */
    private void renderMedia(AssistantBubble b) {
        b.mediaZone.removeAllViews();
        if (b.media.isEmpty()) {
            b.mediaZone.setVisibility(View.GONE);
            return;
        }
        for (MediaItem item : b.media) b.mediaZone.addView(mediaCard(item));
        b.mediaZone.setVisibility(View.VISIBLE);
    }

    private View mediaCard(final MediaItem item) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundResource(R.drawable.bg_card);
        card.setPadding(Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10));

        final TextView status = Ui.tv(this, "", 11, Ui.DIM);

        if (item.isImage()) {
            final ImageView iv = new ImageView(this);
            iv.setAdjustViewBounds(true);
            iv.setScaleType(ImageView.ScaleType.FIT_CENTER);
            LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 190));
            card.addView(iv, ilp);
            loadImage(item.url, iv, status);
        }

        TextView title = Ui.tv(this,
                (item.isAudio() ? "\u266a  Voice clip  " : "\u25a2  Image  ") + item.suggestedName(),
                12, Ui.PRIMARY);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tlp.topMargin = Ui.dp(this, item.isImage() ? 8 : 0);
        card.addView(title, tlp);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rlp.topMargin = Ui.dp(this, 8);

        TextView save = Ui.tv(this, item.savedName != null ? "\u2713 Saved" : "\u2193 Save",
                12, Ui.ACCENT);
        save.setBackgroundResource(R.drawable.bg_pill_ghost);
        save.setPadding(Ui.dp(this, 12), Ui.dp(this, 6), Ui.dp(this, 12), Ui.dp(this, 6));
        save.setOnClickListener(v -> saveMedia(item, save, status));
        row.addView(save);

        TextView open = Ui.tv(this, "Open", 12, Ui.DIM);
        open.setBackgroundResource(R.drawable.bg_pill_ghost);
        open.setPadding(Ui.dp(this, 12), Ui.dp(this, 6), Ui.dp(this, 12), Ui.dp(this, 6));
        LinearLayout.LayoutParams olp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        olp.leftMargin = Ui.dp(this, 6);
        open.setOnClickListener(v -> {
            try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(item.url))); }
            catch (Exception e) { toast("Nothing on this phone can open that file"); }
        });
        row.addView(open, olp);

        card.addView(row, rlp);

        if (item.savedName != null) status.setText("saved as " + item.savedName);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        slp.topMargin = Ui.dp(this, 6);
        card.addView(status, slp);

        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        clp.topMargin = Ui.dp(this, 6);
        clp.rightMargin = Ui.dp(this, 40);
        card.setLayoutParams(clp);
        return card;
    }

    /** Decode off the UI thread; a full-size image must not stall the list. */
    private void loadImage(final String url, final ImageView into, final TextView status) {
        status.setText("loading image\u2026");
        mediaExec.execute(() -> {
            try {
                byte[] data = EngineCore.fetch(url, 90_000);
                BitmapFactory.Options probe = new BitmapFactory.Options();
                probe.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(data, 0, data.length, probe);
                int sample = 1;
                while (probe.outWidth / (sample * 2) >= 1400
                        && probe.outHeight / (sample * 2) >= 1400) sample *= 2;
                BitmapFactory.Options opt = new BitmapFactory.Options();
                opt.inSampleSize = sample;
                final Bitmap bmp = BitmapFactory.decodeByteArray(data, 0, data.length, opt);
                ui.post(() -> {
                    if (bmp == null) {
                        status.setText("image could not be decoded");
                        return;
                    }
                    into.setImageBitmap(bmp);
                    status.setText("");
                });
            } catch (Exception e) {
                ui.post(() -> status.setText("image unavailable: "
                        + EngineCore.scrubUrls(String.valueOf(e.getMessage()))));
            }
        });
    }

    private void saveMedia(final MediaItem item, final TextView button, final TextView status) {
        if (item.savedName != null) {
            toast("already saved as " + item.savedName);
            return;
        }
        button.setText("saving\u2026");
        status.setText("downloading\u2026");
        mediaExec.execute(() -> {
            try {
                byte[] data = EngineCore.fetch(item.url, 120_000);
                String name = item.suggestedName();
                String where = writeToDownloads(name,
                        item.isAudio() ? "audio/wav" : "image/jpeg", data);
                item.savedName = name;
                ui.post(() -> {
                    button.setText("\u2713 Saved");
                    status.setText("saved to " + where);
                    persist();
                    toast("Saved to " + where);
                });
            } catch (Exception e) {
                ui.post(() -> {
                    button.setText("\u2193 Save");
                    status.setText("could not save: "
                            + EngineCore.scrubUrls(String.valueOf(e.getMessage())));
                });
            }
        });
    }

    /**
     * Put the file somewhere the user can find it.
     *
     * On Android 10+ that is the shared Downloads collection through
     * MediaStore, which needs no permission. Below that the shared folder
     * needs a runtime permission this app does not hold, so it goes to the
     * app's own external downloads folder instead and the path is shown --
     * a real path beats a permission dialog that can be denied and leave the
     * button dead.
     */
    private String writeToDownloads(String name, String mime, byte[] data) throws Exception {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
            cv.put(MediaStore.Downloads.MIME_TYPE, mime);
            cv.put(MediaStore.Downloads.RELATIVE_PATH,
                    Environment.DIRECTORY_DOWNLOADS + "/Aether");
            cv.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = getContentResolver()
                    .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            if (uri == null) throw new java.io.IOException("no Downloads collection");
            try (java.io.OutputStream os = getContentResolver().openOutputStream(uri)) {
                if (os == null) throw new java.io.IOException("cannot open output");
                os.write(data);
            }
            cv.clear();
            cv.put(MediaStore.Downloads.IS_PENDING, 0);
            getContentResolver().update(uri, cv, null, null);
            return "Downloads/Aether/" + name;
        }
        java.io.File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) throw new java.io.IOException("no external storage");
        if (!dir.exists() && !dir.mkdirs()) throw new java.io.IOException("cannot create folder");
        java.io.File f = new java.io.File(dir, name);
        try (java.io.FileOutputStream fos = new java.io.FileOutputStream(f)) {
            fos.write(data);
        }
        return f.getAbsolutePath();
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
        if (text.isEmpty() && staged.isEmpty()) return;
        if (cancelFlag != null) {
            toast("Aether is still answering \u2014 press stop to interrupt.");
            return;
        }
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

        /* The task this prompt belongs to. An unfinished task is CONTINUED
           rather than replaced, so "and now deploy it" stays the same job. */
        TaskTracker.begin(current, prompt);

        TextView userBody = addUserBubble(prompt);
        if (attachments != null && !attachments.isEmpty()) {
            addAttachmentChips(userBody, attachments);
        }
        attachMessageActions(userBody, userMsg);

        final AssistantBubble b = addAssistantBubble();
        ChatMessage model = new ChatMessage(ChatMessage.ROLE_ASSISTANT);
        b.model = model;
        current.messages.add(model);
        attachMessageActions(b.contentZone, model);

        liveBubble = b;
        turnStart = System.currentTimeMillis();
        setStreaming(true);
        persist();

        /* The prompt the engine sees: text plus any readable attachment. */
        final String wire = composeWire(prompt, attachments);
        /* And the conversation before it -- without this every message is a
           cold start and "summarise that" has nothing to summarise. */
        final List<EngineCore.Msg> history = historyFor(userMsg, model);

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
                ui.post(() -> pushNotice(b, "Engine " + e.slot.toUpperCase(Locale.ROOT)
                        + " is off \u2014 waking it now. This takes a few minutes; your message"
                        + " will send once it is live."));
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
                streamWithFailover(url, wire, prompt, b, true, history);
                return;
            }

            model.engine = d.slot;
            remember(d.slot, d.url);
            streamWithFailover(d.url, wire, prompt, b, true, history);
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

    /**
     * The conversation before this turn, oldest first.
     *
     * Empty and errored turns are left out: a stopped or failed message is not
     * context worth teaching the model. Capped well inside the engine's own
     * 24-message window.
     */
    private List<EngineCore.Msg> historyFor(ChatMessage thisUser, ChatMessage thisAssistant) {
        List<EngineCore.Msg> out = new ArrayList<>();
        if (current == null) return out;
        for (ChatMessage m : current.messages) {
            if (m == thisUser || m == thisAssistant) continue;
            if (m.content == null || m.content.isEmpty()) continue;
            if (ChatMessage.STATUS_ERROR.equals(m.status)) continue;
            out.add(new EngineCore.Msg(m.isUser() ? "user" : "assistant", m.content));
        }
        final int max = 20;
        if (out.size() > max) {
            return new ArrayList<>(out.subList(out.size() - max, out.size()));
        }
        return out;
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
                                    final AssistantBubble b, final boolean allowFailover,
                                    final List<EngineCore.Msg> history) {
        final boolean[] cancel = new boolean[] {false};
        cancelFlag = cancel;
        /* Captured here because history and wire are only in scope in this
           method, and the failure report is written later from finalizeTurn. */
        b.reqShape = describeRequest(history, wire);
        final long t0 = System.currentTimeMillis();
        final boolean[] ok = new boolean[] {false};
        final String[] err = new String[] {null};
        final AtomicBoolean recorded = new AtomicBoolean(false);

        EngineCore.chatStream(url, cfg.offKey, history, wire, "", cancel,
                new EngineCore.ChatListener() {
                    @Override public void onThinking(String t) {
                        ui.post(() -> {
                            /* Only real operational events are shown or saved.
                               The kernel also streams the model's own reasoning
                               as a thinking event; AgentActivity rejects it and
                               it is dropped here rather than stored. */
                            if (b.activity.event(t) && b.model != null) {
                                b.model.toolLines.add(TextNormalizer.normalize(t));
                            }
                        });
                    }
                    @Override public void onContent(String t) {
                        b.raw.append(t);
                        ui.post(() -> renderAnswer(b, false));
                    }
                    @Override public void onDone(boolean good, String e) {
                        if (recorded.compareAndSet(false, true)) { ok[0] = good; err[0] = e; }
                    }
                    @Override public void onMedia(String kind, String url, String source) {
                        /* Structured event from the kernel, not a URL scraped
                           out of the prose. Recorded on the model message so it
                           survives a restart. */
                        final MediaItem item = new MediaItem(kind, url, source);
                        ui.post(() -> {
                            if (b.model != null) {
                                if (b.model.media == null) {
                                    b.model.media = new ArrayList<>();
                                }
                                b.model.media.add(item);
                            }
                            b.media.add(item);
                            renderMedia(b);
                            persist();
                        });
                    }
                }, EngineCore.StreamPolicy.standard(), turn);

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
                ui.post(() -> pushNotice(b, "Engine " + from.toUpperCase(Locale.ROOT)
                        + " dropped (" + reason + ") \u2014 failing over to "
                        + next.slot.toUpperCase(Locale.ROOT)));
                forget();
                remember(next.slot, next.url);
                if (b.model != null) b.model.engine = next.slot;
                /* The new engine has never seen this task. Hand it the goal and
                   what already succeeded, or it treats the same words as a fresh
                   question and repeats work that had already worked. */
                String carry = wire;
                if (current != null && current.task != null && !current.task.isTerminal()) {
                    carry = current.task.handoff() + "\n\n" + wire;
                }
                streamWithFailover(next.url, carry, prompt, b, false, history);
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
            /* Every turn ends here exactly once: the activity strip is closed
               and its animation cancelled, the answer gets its final layout,
               and whatever the turn really used is shown as sources. A partial
               answer from a stopped turn is kept -- b.raw is untouched. */
            b.activity.finish();
            renderAnswer(b, true);
            addSources(b);
            if (b.model != null) {
                b.model.content = TextNormalizer.normalize(b.raw.toString());
            }
            /* This is the only place a turn ends, so it is the only place a task
               could be left hanging in EXECUTING -- which is what made the agent
               look like it had silently stopped. Whatever the turn really
               produced is recorded here: a stop is CANCELLED, a failure is
               FAILED, and success is only claimed once something was verified. */
            if (current != null && current.task != null) {
                TaskTracker.mirror(current.task, b.activity.model);
                current.task.engine = b.model != null && b.model.engine != null
                        ? b.model.engine : current.engine;
                TaskTracker.close(current.task, ok, err,
                        TextNormalizer.normalize(b.raw.toString()), ms);
                /* Only worth showing when the task actually did something: a
                   plain chat answer needs no report, and adding one to every
                   message would bury the answer the user came for. */
                if (!current.task.steps.isEmpty() || current.task.phase
                        != TaskRecord.Phase.COMPLETED) {
                    String rep = current.task.finalReport();
                    b.model.taskReport = rep;
                    b.activity.report = rep;
                }
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
                telemetry("chat FAILED on engine " + engineOf(b) + " after " + (ms / 1000)
                        + "s: " + err + " | sent " + b.reqShape);
                onError("Engine error: " + err, prompt);
            } else {
                if (b.model != null) b.model.status = ChatMessage.STATUS_OK;
                String who = b.model != null && b.model.engine != null
                        ? "engine " + b.model.engine.toUpperCase(Locale.ROOT) : "Aether";
                b.meta.setText(who + " · " + (ms / 1000) + "s");
                b.meta.setVisibility(View.VISIBLE);
                if (!reportedFirstStream) {
                    reportedFirstStream = true;
                    telemetry("chat OK on engine " + engineOf(b) + " in " + (ms / 1000)
                            + "s, " + b.raw.length() + " chars streamed | sent "
                            + b.reqShape);
                }
            }
            persist();
            refreshChip();
        });
    }

    private static String engineOf(AssistantBubble b) {
        return b != null && b.model != null && b.model.engine != null
                ? b.model.engine.toUpperCase(java.util.Locale.ROOT) : "?";
    }

    /**
     * The shape of the request that was actually put on the wire, so a failure
     * can be diagnosed from the build host without having the device in hand.
     * Counts and role letters only -- never message text, never URLs.
     *
     * This exists because a turn can fail for reasons that are invisible in the
     * transcript: how much history was attached, and whether the engine
     * received a plain user message at all.
     */
    private static String describeRequest(List<EngineCore.Msg> history, String prompt) {
        StringBuilder roles = new StringBuilder();
        int sent = 0;
        if (history != null) {
            for (EngineCore.Msg m : history) {
                if (m == null || m.content == null || m.content.isEmpty()) continue;
                roles.append("assistant".equals(m.role) ? 'a' : 'u');
                sent++;
            }
        }
        roles.append('u');            // the prompt itself is always last
        if (roles.length() > 24) {
            roles = new StringBuilder(roles.substring(roles.length() - 24));
        }
        return sent + " history msgs, roles ...(" + roles + "), prompt "
                + (prompt == null ? 0 : prompt.length()) + " chars";
    }

    /**
     * Report what a turn did, so an installed build can be diagnosed from the
     * build host. Nothing identifying: no keys, no account names, no tunnel
     * URLs (scrubUrls runs here and inside publish).
     */
    private void telemetry(final String what) {
        if (cfg == null || cfg.telemetryTopic == null || cfg.telemetryTopic.isEmpty()) return;
        final String body = "build " + BuildConfig.VERSION_NAME + "(" + BuildConfig.VERSION_CODE
                + ") " + EngineCore.scrubUrls(what);
        telemExec.execute(() -> EngineCore.publish(cfg.telemetryTopic, body, 15_000));
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
        /* The composer stays usable while a turn runs: typing must never be
           blocked by generation. Only sending is gated, and that says so. */
        input.setEnabled(true);
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
