package com.aether.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

import com.aether.app.core.ChatSession;
import com.aether.app.core.ChatStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Settings overview plus focused subscreens, following Android's list/subscreen pattern. */
public class SettingsActivity extends AppCompatActivity {
    private ByokStore store;
    private LinearLayout providerRows;
    private EditText instructions;
    private EditText temperature;
    private EditText maxTokens;
    private EditText timeoutSeconds;
    private android.widget.Switch streamResponses;
    private FrameLayout content;
    private TextView screenTitle;
    private TextView screenSubtitle;
    private LinearLayout homeRows;
    private EditText search;
    private String section = "home";
    private final ExecutorService bg = Executors.newCachedThreadPool();
    private ActivityResultLauncher<String> exportChats;
    private ActivityResultLauncher<String> exportConcern;

    private static final class Destination {
        final String id, title, summary, group;
        final int icon;
        Destination(String id, String group, int icon, String title, String summary) {
            this.id = id; this.group = group; this.icon = icon; this.title = title; this.summary = summary;
        }
    }

    private final List<Destination> destinations = Arrays.asList(
            new Destination("general", "EXPERIENCE", R.drawable.ic_tune, "General", "Startup, keyboard and feedback"),
            new Destination("conversation", "EXPERIENCE", R.drawable.ic_chat, "Conversation & Agent", "Discussion, response style and instructions"),
            new Destination("appearance", "EXPERIENCE", R.drawable.ic_palette, "Appearance", "Theme, text size and motion"),
            new Destination("models", "MODELS", R.drawable.ic_agent, "Models", "Default model and generation controls"),
            new Destination("providers", "MODELS", R.drawable.ic_provider, "Personal Providers", "Your providers, models and encrypted keys"),
            new Destination("activity", "ACTIVITY & DATA", R.drawable.ic_workspace, "Chat & Activity", "Research timeline, sources and history"),
            new Destination("network", "ACTIVITY & DATA", R.drawable.ic_speed, "Network & Performance", "Launch readiness and streaming"),
            new Destination("storage", "ACTIVITY & DATA", R.drawable.ic_database, "Storage & Data", "Export, storage and deletion"),
            new Destination("privacy", "TRUST", R.drawable.ic_shield, "Privacy & Security", "Local data, keys and external services"),
            new Destination("legal", "TRUST", R.drawable.ic_legal, "Legal & Policies", "Disclaimer, terms and content responsibility"),
            new Destination("about", "TRUST", R.drawable.ic_info, "About Aether", "Version, capabilities and notices")
    );

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);
        store = new ByokStore(this);
        content = findViewById(R.id.settings_content);
        screenTitle = findViewById(R.id.settings_title);
        screenSubtitle = findViewById(R.id.settings_subtitle);
        findViewById(R.id.back_btn).setOnClickListener(v -> navigateBack());
        exportChats = registerForActivityResult(new ActivityResultContracts.CreateDocument("application/json"), this::writeExport);
        exportConcern = registerForActivityResult(new ActivityResultContracts.CreateDocument("text/plain"), this::writeConcern);
        String requested = getIntent().getStringExtra("section");
        if (requested == null) showHome(); else showSection(requested);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { navigateBack(); }
        });
    }

    @Override protected void onPause() {
        if (instructions != null) saveAgentSettings();
        super.onPause();
    }

    @Override protected void onDestroy() {
        bg.shutdownNow();
        super.onDestroy();
    }

    private void navigateBack() {
        if (!"home".equals(section)) showHome(); else finish();
    }

    private void showHome() {
        section = "home";
        screenTitle.setText("Settings");
        screenSubtitle.setText("Your workspace. Your rules.");
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout body = sectionBody(scroll);
        TextView hero = Ui.tv(this, "Make Aether work the way you do.", 22, Ui.PRIMARY);
        hero.setTypeface(Typeface.DEFAULT_BOLD);
        body.addView(hero);
        body.addView(subtitle("Choose a category. Every option has its own space."));
        search = input("Search settings", "");
        search.setCompoundDrawablesWithIntrinsicBounds(R.drawable.ic_search, 0, 0, 0);
        search.setCompoundDrawablePadding(Ui.dp(this, 10));
        body.addView(search, matchParams(16));
        homeRows = new LinearLayout(this);
        homeRows.setOrientation(LinearLayout.VERTICAL);
        body.addView(homeRows);
        search.addTextChangedListener(new SimpleWatcher(() -> renderHomeRows(search.getText().toString())));
        renderHomeRows("");
        content.removeAllViews();
        content.addView(scroll);
    }

    private void renderHomeRows(String filter) {
        if (homeRows == null) return;
        homeRows.removeAllViews();
        String lastGroup = "";
        String query = filter == null ? "" : filter.trim().toLowerCase(Locale.ROOT);
        int matches = 0;
        for (Destination d : destinations) {
            if (!query.isEmpty() && !(d.title + " " + d.summary).toLowerCase(Locale.ROOT).contains(query)) continue;
            matches++;
            if (!d.group.equals(lastGroup)) {
                homeRows.addView(groupLabel(d.group));
                lastGroup = d.group;
            }
            homeRows.addView(destinationRow(d));
        }
        if (matches == 0) homeRows.addView(Ui.centered(this, "No settings match that search.", 14, Ui.DIM));
    }

    private View destinationRow(Destination d) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setBackgroundResource(R.drawable.bg_settings_row);
        row.setPadding(Ui.dp(this, 14), Ui.dp(this, 13), Ui.dp(this, 12), Ui.dp(this, 13));
        ImageView icon = new ImageView(this);
        icon.setImageResource(d.icon);
        icon.setBackgroundResource(R.drawable.bg_icon_tile);
        icon.setPadding(Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10));
        row.addView(icon, new LinearLayout.LayoutParams(Ui.dp(this, 42), Ui.dp(this, 42)));
        LinearLayout words = new LinearLayout(this);
        words.setOrientation(LinearLayout.VERTICAL);
        words.setPadding(Ui.dp(this, 13), 0, Ui.dp(this, 8), 0);
        TextView title = Ui.tv(this, d.title, 15, Ui.PRIMARY);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        words.addView(title);
        words.addView(Ui.meta(this, summaryFor(d)));
        row.addView(words, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        ImageView chevron = new ImageView(this);
        chevron.setImageResource(R.drawable.ic_chevron);
        chevron.setAlpha(.55f);
        row.addView(chevron, new LinearLayout.LayoutParams(Ui.dp(this, 22), Ui.dp(this, 22)));
        row.setOnClickListener(v -> showSection(d.id));
        row.setForeground(resolveSelectable());
        LinearLayout.LayoutParams lp = matchParams(6);
        row.setLayoutParams(lp);
        return row;
    }

    private String summaryFor(Destination d) {
        if ("providers".equals(d.id)) {
            int n = store.list().size();
            return n == 0 ? "Connect your own provider" : n + (n == 1 ? " provider connected" : " providers connected");
        }
        if ("models".equals(d.id)) {
            return ModelPrefs.BYOK.equals(ModelPrefs.kind(this)) ? "Personal provider selected" : ModelPrefs.AETHER_LABEL + " selected";
        }
        if ("appearance".equals(d.id)) return AetherPrefs.theme(this) + " · " + Math.round(AetherPrefs.textScale(this) * 100) + "% text";
        if ("conversation".equals(d.id)) return (AetherPrefs.discussion(this) ? "Discussion" : "Agent") + " · " + AetherPrefs.responseStyle(this);
        return d.summary;
    }

    private void showSection(String id) {
        section = id;
        instructions = null;
        switch (id) {
            case "general": showGeneral(); break;
            case "conversation": showConversation(); break;
            case "appearance": showAppearance(); break;
            case "models": showModels(); break;
            case "providers": showProviders(); break;
            case "activity": showActivity(); break;
            case "network": showNetwork(); break;
            case "storage": showStorage(); break;
            case "privacy": showPrivacy(); break;
            case "legal": showLegal(); break;
            case "about": showAbout(); break;
            default: showHome();
        }
    }

    private LinearLayout openSection(String title, String subtitle) {
        screenTitle.setText(title);
        screenSubtitle.setText(subtitle);
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout body = sectionBody(scroll);
        content.removeAllViews();
        content.addView(scroll);
        return body;
    }

    private void showGeneral() {
        LinearLayout b = openSection("General", "Everyday behavior, without the clutter.");
        b.addView(groupLabel("STARTUP"));
        choice(b, "When Aether opens", AetherPrefs.openLastChat(this) ? "Continue the last chat" : "Start a fresh chat",
                new String[]{"Start a fresh chat", "Continue the last chat"}, value -> AetherPrefs.openLastChat(this, value.startsWith("Continue")));
        toggle(b, "Send with Enter", "Off keeps Enter available for a new line.", AetherPrefs.sendOnEnter(this), value -> AetherPrefs.sendOnEnter(this, value));
        toggle(b, "Touch feedback", "A subtle response when you send a message.", AetherPrefs.haptics(this), value -> AetherPrefs.haptics(this, value));
        b.addView(groupLabel("GUIDANCE"));
        action(b, "Review the welcome disclaimer", "Adult use, accuracy and responsibility", () -> showDocument("Welcome to Aether", LegalText.DISCLAIMER));
    }

    private void showConversation() {
        LinearLayout b = openSection("Conversation & Agent", "Choose how Aether approaches each turn.");
        b.addView(groupLabel("DEFAULT STYLE"));
        choice(b, "Default composer mode", AetherPrefs.discussion(this) ? "Discussion" : "Agent",
                new String[]{"Agent", "Discussion"}, value -> AetherPrefs.discussion(this, "Discussion".equals(value)));
        choice(b, "Response style", AetherPrefs.responseStyle(this), new String[]{"Concise", "Balanced", "Detailed"}, value -> AetherPrefs.responseStyle(this, value));
        b.addView(infoCard("Agent can research, browse, run commands and create files. Discussion focuses on the conversation and requests no tools. You can switch modes in the composer at any time."));
        b.addView(groupLabel("CUSTOM INSTRUCTIONS"));
        ByokClient.ChatOptions options = AgentSettings.load(this);
        instructions = input("Example: answer plainly and state assumptions", options.instructions);
        instructions.setMinLines(5);
        instructions.setGravity(Gravity.TOP | Gravity.START);
        b.addView(instructions, matchParams(8));
        b.addView(subtitle("These instructions shape responses. They do not override law, privacy, or provider rules."));
        b.addView(groupLabel("PERSONAL PROVIDER GENERATION"));
        temperature = input("Temperature", String.format(Locale.US, "%s", options.temperature));
        temperature.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
        maxTokens = input("Maximum output tokens", String.valueOf(options.maxTokens));
        maxTokens.setInputType(InputType.TYPE_CLASS_NUMBER);
        timeoutSeconds = input("Timeout in seconds", String.valueOf(options.timeoutMs / 1000));
        timeoutSeconds.setInputType(InputType.TYPE_CLASS_NUMBER);
        b.addView(temperature, matchParams(8));
        b.addView(maxTokens, matchParams(8));
        b.addView(timeoutSeconds, matchParams(8));
        streamResponses = new android.widget.Switch(this);
        styleSwitch(streamResponses, "Stream responses", options.streaming);
        b.addView(streamResponses, matchParams(10));
        action(b, "Save conversation settings", "Apply instructions and generation controls", () -> { saveAgentSettings(); toast("Conversation settings saved."); showHome(); });
    }

    private void showAppearance() {
        LinearLayout b = openSection("Appearance", "A calm interface, tuned to you.");
        b.addView(groupLabel("THEME"));
        choice(b, "App theme", AetherPrefs.theme(this), new String[]{"Midnight", "Light", "System"}, value -> { AetherPrefs.theme(this, value); recreate(); });
        choice(b, "Text size", Math.round(AetherPrefs.textScale(this) * 100) + "%", new String[]{"90%", "100%", "115%", "120%"}, value -> {
            AetherPrefs.textScale(this, Integer.parseInt(value.replace("%", "")) / 100f); recreate();
        });
        toggle(b, "Interface motion", "Composer, activity and model-picker transitions.", AetherPrefs.animations(this), value -> AetherPrefs.animations(this, value));
        b.addView(infoCard("System animation settings are always respected. Turning motion off removes decorative movement; real progress and streaming text still update."));
    }

    private void showModels() {
        LinearLayout b = openSection("Models", "One clear choice for every conversation.");
        String current = ModelPrefs.BYOK.equals(ModelPrefs.kind(this)) ? "Personal provider" : ModelPrefs.AETHER_LABEL;
        b.addView(heroCard(current, ModelPrefs.BYOK.equals(ModelPrefs.kind(this))
                ? "Your selected provider and model are used for new turns."
                : "Built in. Automatic readiness and continuity stay behind the scenes."));
        action(b, "Choose a model", "Built-in and personal providers", () -> ModelPickerDialog.show(this, store, this::showModels));
        action(b, "Manage personal providers", "Add, test, edit or remove a connection", () -> showSection("providers"));
        b.addView(groupLabel("HOW IT WORKS"));
        b.addView(infoCard("Model choice is remembered on this device. Personal providers receive requests directly. Built-in turns retain Aether's workspace tools; personal-provider turns use chat completions."));
    }

    private void showProviders() {
        LinearLayout b = openSection("Personal Providers", "Your keys. Your models. Direct connections.");
        action(b, "Add a provider", "OpenAI-compatible services and public HTTPS endpoints", () -> editProvider(null));
        providerRows = new LinearLayout(this);
        providerRows.setOrientation(LinearLayout.VERTICAL);
        b.addView(providerRows, matchParams(10));
        renderProviders();
        action(b, "Remove all providers and keys", "Keep chat history; delete every saved connection", this::confirmClear);
        b.addView(infoCard("A successful test is the only thing that marks a provider verified. Saved keys and suggested model names are not verification."));
    }

    private void showActivity() {
        LinearLayout b = openSection("Chat & Activity", "See the work without reading a console.");
        toggle(b, "Show live activity", "Animated research, browsing, command and creation steps.", AetherPrefs.showActivity(this), value -> AetherPrefs.showActivity(this, value));
        toggle(b, "Show source details", "Expand websites and sources used by a completed turn.", AetherPrefs.expandSources(this), value -> AetherPrefs.expandSources(this, value));
        b.addView(infoCard("Activity is based on events from the selected engine. A finished action is not proof that the answer is correct; open sources and verify important claims."));
    }

    private void showNetwork() {
        LinearLayout b = openSection("Network & Performance", "Ready when you are, honest about the trade-offs.");
        toggle(b, "Prepare on launch", "Start waking configured built-in routes in parallel when the app opens.", AetherPrefs.warmOnLaunch(this), value -> {
            AetherPrefs.warmOnLaunch(this, value);
            if (value) FleetWarmup.warmAll(getApplicationContext());
        });
        b.addView(infoCard("Parallel preparation reduces app-side waiting. Kaggle allocation, downloads, provider latency, quota and network conditions still determine actual readiness. Preparing all routes can consume more GPU quota."));
        b.addView(groupLabel("BUILT-IN CONTINUITY"));
        b.addView(infoCard("Healthy routes are reused for fast consecutive messages. If a connection drops, Aether tries untried routes in sequence and carries the existing task forward."));
    }

    private void showStorage() {
        LinearLayout b = openSection("Storage & Data", "Your conversations stay under your control.");
        b.addView(heroCard(readableSize(folderSize(getFilesDir())), "Used by Aether's private app storage, including chats and attachments."));
        action(b, "Export chats", "Create a JSON document without personal provider keys", () -> exportChats.launch("aether-chats.json"));
        action(b, "Clear chat history", "Delete every local chat and copied attachment", this::confirmClearHistory);
        b.addView(infoCard("Exports contain conversation content and local task details. They never include personal provider API keys. Review an export before sharing it."));
    }

    private void showPrivacy() {
        LinearLayout b = openSection("Privacy & Security", "Clear boundaries, in plain language.");
        action(b, "Read the Privacy Policy", "Storage, requests, providers and third parties", () -> showDocument("Privacy Policy", LegalText.PRIVACY));
        action(b, "Remove personal providers and keys", "Delete encrypted keys and connection metadata", this::confirmClear);
        b.addView(groupLabel("ON THIS DEVICE"));
        b.addView(infoCard("Chats use app-private storage. Personal keys use Android Keystore encryption. Android backup is disabled. Personal-provider requests go directly to the selected provider."));
        b.addView(groupLabel("OUTSIDE THIS DEVICE"));
        b.addView(infoCard("Built-in tools and personal providers contact external services. Their retention and handling are governed by their own policies. Local deletion cannot retract data already sent."));
    }

    private void showLegal() {
        LinearLayout b = openSection("Legal & Policies", "Plain language for adult, responsible use.");
        action(b, "Disclaimer", "Accuracy, adult use and important limitations", () -> showDocument("Disclaimer", LegalText.DISCLAIMER));
        action(b, "Terms of Use", "Acceptable use, content and responsibility", () -> showDocument("Terms of Use", LegalText.TERMS));
        action(b, "Privacy Policy", "Local data, provider requests and retention", () -> showDocument("Privacy Policy", LegalText.PRIVACY));
        action(b, "Content & Responsibility", "Research, sources and prohibited harm", () -> showDocument("Content & Responsibility", LegalText.CONTENT));
        action(b, "Prepare a concern report", "Create a draft; choose where to send it", () -> exportConcern.launch("aether-concern.txt"));
        b.addView(subtitle("Policy revision: November 2026. These in-app templates are not a substitute for advice from a qualified lawyer in your jurisdiction."));
    }

    private void showAbout() {
        LinearLayout b = openSection("About Aether", "Conversation, research and creation in one place.");
        b.addView(heroCard("Aether", "Version " + BuildConfig.VERSION_NAME + " · made for focused work and open adult conversation."));
        b.addView(infoCard("Use Agent for research, websites, files and commands. Switch to Discussion for a quieter conversation. Choose a personal provider when you want to use your own account."));
        action(b, "Third-party notices", "Services and provider names", () -> showDocument("Third-party Notices", LegalText.NOTICES));
        action(b, "Legal & Policies", "Disclaimer, terms, privacy and responsibility", this::showLegal);
    }

    private void showDocument(String title, String text) {
        section = "document";
        LinearLayout b = openSection(title, "Aether · November 2026");
        TextView body = Ui.tv(this, text, 15, Ui.PRIMARY);
        body.setLineSpacing(Ui.dp(this, 6), 1f);
        body.setTextIsSelectable(true);
        b.addView(body, matchParams(8));
        action(b, "Back to Legal & Policies", "", this::showLegal);
    }

    // ---------------------------------------------------------- controls

    private LinearLayout sectionBody(ScrollView scroll) {
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(Ui.dp(this, 18), Ui.dp(this, 8), Ui.dp(this, 18), Ui.dp(this, 36));
        scroll.addView(body);
        return body;
    }

    private TextView groupLabel(String text) {
        TextView t = Ui.tv(this, text, 11, Ui.ACCENT);
        t.setLetterSpacing(.1f);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(Ui.dp(this, 4), Ui.dp(this, 22), 0, Ui.dp(this, 7));
        return t;
    }

    private TextView subtitle(String text) {
        TextView t = Ui.tv(this, text, 12, Ui.DIM);
        t.setPadding(Ui.dp(this, 3), Ui.dp(this, 6), Ui.dp(this, 3), Ui.dp(this, 6));
        return t;
    }

    private View infoCard(String text) {
        TextView t = Ui.tv(this, text, 13, Ui.DIM);
        t.setBackgroundResource(R.drawable.bg_card);
        t.setPadding(Ui.dp(this, 15), Ui.dp(this, 14), Ui.dp(this, 15), Ui.dp(this, 14));
        t.setLineSpacing(Ui.dp(this, 3), 1f);
        t.setLayoutParams(matchParams(10));
        return t;
    }

    private View heroCard(String title, String summary) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundResource(R.drawable.bg_hero);
        card.setPadding(Ui.dp(this, 18), Ui.dp(this, 20), Ui.dp(this, 18), Ui.dp(this, 20));
        TextView heading = Ui.tv(this, title, 24, Ui.PRIMARY);
        heading.setTypeface(Typeface.DEFAULT_BOLD);
        card.addView(heading);
        TextView sub = Ui.tv(this, summary, 13, Ui.DIM);
        sub.setLineSpacing(Ui.dp(this, 3), 1f);
        card.addView(sub, matchParams(8));
        card.setLayoutParams(matchParams(12));
        return card;
    }

    private void action(LinearLayout body, String title, String summary, Runnable run) {
        LinearLayout row = actionRow(title, summary, R.drawable.ic_chevron, run);
        body.addView(row, matchParams(7));
    }

    private LinearLayout actionRow(String title, String summary, int icon, Runnable run) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setBackgroundResource(R.drawable.bg_settings_row);
        row.setPadding(Ui.dp(this, 15), Ui.dp(this, 13), Ui.dp(this, 13), Ui.dp(this, 13));
        LinearLayout words = new LinearLayout(this);
        words.setOrientation(LinearLayout.VERTICAL);
        TextView t = Ui.tv(this, title, 14, Ui.PRIMARY);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        words.addView(t);
        if (summary != null && !summary.isEmpty()) words.addView(Ui.meta(this, summary));
        row.addView(words, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        ImageView chevron = new ImageView(this);
        chevron.setImageResource(icon);
        row.addView(chevron, new LinearLayout.LayoutParams(Ui.dp(this, 22), Ui.dp(this, 22)));
        row.setOnClickListener(v -> run.run());
        row.setForeground(resolveSelectable());
        return row;
    }

    private void choice(LinearLayout body, String title, String current, String[] values, ValueConsumer consumer) {
        action(body, title, current, () -> new AlertDialog.Builder(this).setTitle(title).setItems(values, (d, which) -> {
            consumer.accept(values[which]);
            showSection(section);
        }).setNegativeButton(R.string.cancel, null).show());
    }

    private void toggle(LinearLayout body, String title, String summary, boolean value, BoolConsumer consumer) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setBackgroundResource(R.drawable.bg_settings_row);
        row.setPadding(Ui.dp(this, 15), Ui.dp(this, 10), Ui.dp(this, 12), Ui.dp(this, 10));
        LinearLayout words = new LinearLayout(this);
        words.setOrientation(LinearLayout.VERTICAL);
        TextView t = Ui.tv(this, title, 14, Ui.PRIMARY);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        words.addView(t);
        words.addView(Ui.meta(this, summary));
        row.addView(words, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        android.widget.Switch sw = new android.widget.Switch(this);
        sw.setChecked(value);
        sw.setOnCheckedChangeListener((button, checked) -> consumer.accept(checked));
        row.addView(sw);
        body.addView(row, matchParams(7));
    }

    private void styleSwitch(android.widget.Switch sw, String title, boolean value) {
        sw.setText(title);
        sw.setTextColor(getColor(R.color.aether_fg));
        sw.setTextSize(14);
        sw.setChecked(value);
    }

    private EditText input(String hint, String value) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setText(value);
        e.setTextSize(14);
        e.setTextColor(getColor(R.color.aether_fg));
        e.setHintTextColor(getColor(R.color.aether_dim));
        e.setBackgroundResource(R.drawable.bg_field);
        e.setPadding(Ui.dp(this, 13), Ui.dp(this, 12), Ui.dp(this, 13), Ui.dp(this, 12));
        e.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        return e;
    }

    private android.graphics.drawable.Drawable resolveSelectable() {
        android.util.TypedValue value = new android.util.TypedValue();
        getTheme().resolveAttribute(android.R.attr.selectableItemBackground, value, true);
        return getDrawable(value.resourceId);
    }

    private LinearLayout.LayoutParams matchParams(int topDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Ui.dp(this, topDp);
        return lp;
    }

    private void saveAgentSettings() {
        double temp = parseDouble(temperature.getText().toString(), 0.7);
        int tokens = parseInt(maxTokens.getText().toString(), 2048);
        int seconds = parseInt(timeoutSeconds.getText().toString(), 60);
        AgentSettings.save(this, instructions.getText().toString(), temp, tokens, seconds * 1000, streamResponses.isChecked());
    }

    private static double parseDouble(String raw, double fallback) {
        try { return Double.parseDouble(raw.trim()); } catch (Exception e) { return fallback; }
    }

    private static int parseInt(String raw, int fallback) {
        try { return Integer.parseInt(raw.trim()); } catch (Exception e) { return fallback; }
    }

    private interface BoolConsumer { void accept(boolean value); }
    private interface ValueConsumer { void accept(String value); }

    private void confirmClearHistory() {
        new AlertDialog.Builder(this).setTitle("Clear every chat?")
                .setMessage("All local conversations and copied attachments will be deleted. Personal providers and settings remain.")
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton("Clear history", (d, w) -> bg.execute(() -> {
                    int count = new ChatStore(new File(getFilesDir(), "chats")).deleteAll();
                    AetherPrefs.requestHistoryReset(this);
                    runOnUiThread(() -> { toast(count + (count == 1 ? " chat deleted." : " chats deleted.")); showHome(); });
                })).show();
    }

    private long folderSize(File file) {
        if (file == null || !file.exists()) return 0;
        if (file.isFile()) return file.length();
        long total = 0;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) total += folderSize(child);
        return total;
    }

    private String readableSize(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format(Locale.US, "%.1f KB", bytes / 1024f);
        return String.format(Locale.US, "%.1f MB", bytes / (1024f * 1024f));
    }

    private void writeExport(Uri uri) {
        if (uri == null) return;
        bg.execute(() -> {
            try {
                JSONObject root = new JSONObject();
                root.put("product", "Aether");
                root.put("exportedAt", System.currentTimeMillis());
                root.put("personalProviderKeysIncluded", false);
                JSONArray chats = new JSONArray();
                ChatStore chatStore = new ChatStore(new File(getFilesDir(), "chats"));
                for (ChatStore.Meta meta : chatStore.list()) {
                    ChatSession chat = chatStore.load(meta.id);
                    if (chat != null) chats.put(chat.toJson());
                }
                root.put("chats", chats);
                try (OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
                    if (out == null) throw new Exception("The destination could not be opened.");
                    out.write(root.toString(2).getBytes(StandardCharsets.UTF_8));
                }
                runOnUiThread(() -> toast("Chats exported without provider keys."));
            } catch (Exception e) {
                runOnUiThread(() -> toast("Export failed: " + e.getMessage()));
            }
        });
    }

    private void writeConcern(Uri uri) {
        if (uri == null) return;
        String report = "Aether concern report\n\nCreated: " + new java.util.Date() + "\nApp version: "
                + BuildConfig.VERSION_NAME + "\n\nDescribe the answer or behavior that concerned you:\n\n\n"
                + "What did you expect instead?\n\n\nDo not include passwords, provider keys, or private documents.\n";
        try (OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) throw new Exception("The destination could not be opened.");
            out.write(report.getBytes(StandardCharsets.UTF_8));
            toast("Report draft created. Choose where to share it from your document app.");
        } catch (Exception e) {
            toast("The report could not be created: " + e.getMessage());
        }
    }

    private void renderProviders() {
        providerRows.removeAllViews();
        List<ByokClient.Connection> connections = store.list();
        if (connections.isEmpty()) {
            providerRows.addView(Ui.centered(this,
                    "No personal providers yet. Aether Uncensored remains available independently.", 12,
                    Ui.DIM));
            return;
        }
        for (ByokClient.Connection c : connections) {
            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setBackgroundResource(R.drawable.bg_card);
            card.setPadding(Ui.dp(this, 14), Ui.dp(this, 12), Ui.dp(this, 14), Ui.dp(this, 12));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.topMargin = Ui.dp(this, 8);
            card.setLayoutParams(lp);

            String verification = "verified".equals(c.testStatus) ? " · VERIFIED"
                    : "failed".equals(c.testStatus) ? " · TEST FAILED" : " · NOT VERIFIED";
            TextView title = Ui.tv(this, c.name + verification, 14,
                    "verified".equals(c.testStatus) ? Ui.OK
                            : "failed".equals(c.testStatus) ? Ui.ERROR : Ui.PRIMARY);
            title.setTypeface(Typeface.DEFAULT_BOLD);
            card.addView(title);
            card.addView(Ui.meta(this, c.baseUrl + (c.enabled ? "" : " · disabled")));
            card.addView(Ui.meta(this, c.hasKey ? "API key encrypted with Android Keystore" : "No saved API key"));

            Button defaultModel = new Button(this);
            defaultModel.setText("Default model: " + c.defaultModel);
            defaultModel.setTextSize(12);
            defaultModel.setTextColor(getColor(R.color.aether_fg));
            defaultModel.setBackgroundResource(R.drawable.bg_pill_ghost);
            defaultModel.setOnClickListener(v -> chooseDefaultModel(c));
            card.addView(defaultModel, buttonParams());

            LinearLayout actions = new LinearLayout(this);
            actions.setOrientation(LinearLayout.HORIZONTAL);
            actions.addView(actionButton(c.enabled ? "Disable" : "Enable", v -> {
                c.enabled = !c.enabled;
                saveConnection(c);
                if (!c.enabled && ModelPrefs.BYOK.equals(ModelPrefs.kind(this))
                        && c.id.equals(ModelPrefs.connectionId(this))) ModelPrefs.selectAether(this);
            }));
            actions.addView(actionButton("Edit", v -> editProvider(c)));
            actions.addView(actionButton("Remove", v -> confirmRemove(c)));
            card.addView(actions);

            if (!c.testMessage.isEmpty()) {
                card.addView(Ui.meta(this, c.testMessage
                        + (c.testedAt > 0 ? " · " + android.text.format.DateFormat.format(
                                "yyyy-MM-dd HH:mm", c.testedAt) : "")));
            }
            providerRows.addView(card);
        }
    }

    private LinearLayout.LayoutParams buttonParams() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Ui.dp(this, 8);
        return lp;
    }

    private Button actionButton(String label, View.OnClickListener listener) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextSize(11);
        b.setTextColor(getColor(R.color.aether_fg));
        b.setBackgroundResource(R.drawable.bg_pill_ghost);
        b.setOnClickListener(listener);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        lp.topMargin = Ui.dp(this, 6);
        lp.rightMargin = Ui.dp(this, 4);
        b.setLayoutParams(lp);
        return b;
    }

    private void saveConnection(ByokClient.Connection c) {
        try {
            store.save(c);
            renderProviders();
        } catch (Exception e) {
            toast(e.getMessage());
        }
    }

    private void chooseDefaultModel(ByokClient.Connection c) {
        if (c.models.isEmpty()) {
            editProvider(c);
            return;
        }
        String[] models = c.models.toArray(new String[0]);
        new AlertDialog.Builder(this)
                .setTitle("Default model · " + c.name)
                .setItems(models, (dialog, which) -> {
                    c.defaultModel = models[which];
                    saveConnection(c);
                    if (ModelPrefs.BYOK.equals(ModelPrefs.kind(this))
                            && c.id.equals(ModelPrefs.connectionId(this))) {
                        ModelPrefs.selectByok(this, c.id, c.defaultModel);
                    }
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    private void confirmRemove(ByokClient.Connection c) {
        new AlertDialog.Builder(this)
                .setTitle("Remove " + c.name + "?")
                .setMessage("The provider record and its encrypted API key will be removed from this device.")
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton("Remove", (dialog, which) -> {
                    store.delete(c.id);
                    if (ModelPrefs.BYOK.equals(ModelPrefs.kind(this))
                            && c.id.equals(ModelPrefs.connectionId(this))) ModelPrefs.selectAether(this);
                    renderProviders();
                }).show();
    }

    private void confirmClear() {
        if (store.list().isEmpty()) {
            toast("There are no personal providers to remove.");
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("Remove every personal provider?")
                .setMessage("All personal provider records and encrypted keys will be removed from this device. Chat history remains.")
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton("Remove all", (dialog, which) -> {
                    store.clear();
                    ModelPrefs.selectAether(this);
                    renderProviders();
                    toast("Personal providers and keys removed.");
                }).show();
    }

    // ------------------------------------------------------------ editor

    private void editProvider(ByokClient.Connection existing) {
        ByokClient.Connection original = existing == null ? null : existing.copy();
        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(Ui.dp(this, 20), Ui.dp(this, 12), Ui.dp(this, 20), Ui.dp(this, 12));
        scroll.addView(root);

        List<ByokClient.Provider> providers = ByokClient.providers();
        List<String> providerNames = new ArrayList<>();
        int providerIndex = 0;
        for (int i = 0; i < providers.size(); i++) {
            providerNames.add(providers.get(i).name);
            if (original != null && providers.get(i).id.equals(original.provider)) providerIndex = i;
        }
        Spinner provider = new Spinner(this);
        provider.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, providerNames));
        root.addView(fieldLabel("Provider connector"));
        root.addView(provider);

        EditText name = providerInput(original == null ? providers.get(0).name : original.name, "Display name");
        EditText baseUrl = providerInput(original == null ? providers.get(0).baseUrl : original.baseUrl,
                "https://provider.example.com/v1");
        EditText apiKey = providerInput("", original == null ? "Paste your API key" : "Leave blank to keep the saved key");
        apiKey.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        apiKey.setAutofillHints("");
        EditText models = providerInput(joinModels(original == null ? providers.get(0).suggestedModels : original.models),
                "Model IDs, one per line");
        models.setMinLines(4);
        models.setGravity(android.view.Gravity.TOP | android.view.Gravity.START);
        EditText defaultModel = providerInput(original == null
                ? (providers.get(0).suggestedModels.isEmpty() ? "" : providers.get(0).suggestedModels.get(0))
                : original.defaultModel, "Default model ID");
        CheckBox enabled = new CheckBox(this);
        enabled.setText("Enabled");
        enabled.setTextColor(getColor(R.color.aether_fg));
        enabled.setChecked(original == null || original.enabled);

        root.addView(fieldLabel("Display name")); root.addView(name);
        root.addView(fieldLabel("API base URL")); root.addView(baseUrl);
        root.addView(fieldLabel("API key")); root.addView(apiKey);
        root.addView(fieldLabel("Model IDs · one per line")); root.addView(models);
        root.addView(fieldLabel("Default model")); root.addView(defaultModel);
        root.addView(enabled);

        TextView help = Ui.meta(this, "Built-in connector URLs are managed automatically. Custom endpoints "
                + "require public HTTPS and implement GET /models and POST /chat/completions. Suggested model "
                + "IDs are hints, not proof of availability.");
        root.addView(help);
        TextView status = Ui.tv(this, original == null || original.testMessage.isEmpty()
                ? "Not verified" : original.testMessage, 12, Ui.DIM);
        root.addView(status);

        Button test = new Button(this);
        test.setText("Test & discover models");
        test.setBackgroundResource(R.drawable.bg_pill_ghost);
        test.setTextColor(getColor(R.color.aether_fg));
        Button save = new Button(this);
        save.setText(original == null ? "Save provider" : "Save changes");
        save.setBackgroundResource(R.drawable.bg_pill_accent);
        save.setTextColor(getColor(R.color.aether_bg));
        root.addView(test, buttonParams());
        root.addView(save, buttonParams());

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(original == null ? "Add a personal provider" : "Edit " + original.name)
                .setView(scroll)
                .setNegativeButton(R.string.cancel, null)
                .create();
        provider.setSelection(providerIndex);
        if (original != null) provider.setEnabled(false);
        baseUrl.setEnabled(original == null || "custom".equals(original.provider));

        final String[] testState = new String[] {
                original == null ? "" : original.testStatus,
                original == null ? "" : original.testMessage,
                String.valueOf(original == null ? 0L : original.testedAt)
        };
        TextWatcher invalidate = new SimpleWatcher(() -> {
            testState[0] = ""; testState[1] = ""; testState[2] = "0";
            status.setText("Not verified · connection details changed");
            status.setTextColor(getColor(R.color.aether_muted));
        });
        apiKey.addTextChangedListener(invalidate);
        baseUrl.addTextChangedListener(invalidate);

        provider.setOnItemSelectedListener(new SimpleItemSelectedListener(position -> {
            if (original != null) return;
            ByokClient.Provider p = providers.get(position);
            name.setText(p.name);
            baseUrl.setText(p.baseUrl);
            baseUrl.setEnabled("custom".equals(p.id));
            models.setText(joinModels(p.suggestedModels));
            defaultModel.setText(p.suggestedModels.isEmpty() ? "" : p.suggestedModels.get(0));
            testState[0] = ""; testState[1] = "";
        }));

        test.setOnClickListener(v -> {
            ByokClient.Provider selected = original == null ? providers.get(provider.getSelectedItemPosition())
                    : ByokClient.provider(original.provider);
            ByokClient.Connection draft = draft(original, selected, name, baseUrl, apiKey, models, defaultModel, enabled);
            try {
                if (draft.apiKey.isEmpty() && original != null) draft.apiKey = store.withKey(original.id).apiKey;
            } catch (Exception e) {
                status.setText(e.getMessage());
                return;
            }
            test.setEnabled(false);
            save.setEnabled(false);
            status.setText("Testing the real provider endpoint…");
            status.setTextColor(getColor(R.color.aether_warn));
            bg.execute(() -> {
                try {
                    List<String> discovered = ByokClient.discoverModels(draft);
                    runOnUiThread(() -> {
                        if (isDestroyed()) return;
                        testState[0] = "verified";
                        testState[1] = "Provider responded successfully with " + discovered.size() + " models.";
                        testState[2] = String.valueOf(System.currentTimeMillis());
                        status.setText(testState[1]);
                        status.setTextColor(getColor(R.color.aether_ok));
                        Set<String> merged = new LinkedHashSet<>(discovered);
                        merged.addAll(splitModels(models.getText().toString()));
                        models.setText(joinModels(new ArrayList<>(merged)));
                        if (!discovered.contains(defaultModel.getText().toString()) && !discovered.isEmpty()) {
                            defaultModel.setText(discovered.get(0));
                        }
                        test.setEnabled(true); save.setEnabled(true);
                    });
                } catch (Exception e) {
                    runOnUiThread(() -> {
                        if (isDestroyed()) return;
                        testState[0] = "failed";
                        testState[1] = e.getMessage() == null ? "Connection test failed." : e.getMessage();
                        testState[2] = String.valueOf(System.currentTimeMillis());
                        status.setText("Not verified · " + testState[1]);
                        status.setTextColor(getColor(R.color.aether_error));
                        test.setEnabled(true); save.setEnabled(true);
                    });
                }
            });
        });

        save.setOnClickListener(v -> {
            ByokClient.Provider selected = original == null ? providers.get(provider.getSelectedItemPosition())
                    : ByokClient.provider(original.provider);
            ByokClient.Connection draft = draft(original, selected, name, baseUrl, apiKey, models, defaultModel, enabled);
            draft.testStatus = testState[0]; draft.testMessage = testState[1];
            try { draft.testedAt = Long.parseLong(testState[2]); } catch (Exception ignored) { }
            save.setEnabled(false);
            bg.execute(() -> {
                try {
                    store.save(draft);
                    runOnUiThread(() -> {
                        if (isDestroyed()) return;
                        renderProviders();
                        dialog.dismiss();
                        toast("verified".equals(draft.testStatus)
                                ? "Verified provider saved." : "Provider saved locally; connection not verified.");
                    });
                } catch (Exception e) {
                    runOnUiThread(() -> {
                        if (isDestroyed()) return;
                        save.setEnabled(true);
                        status.setText(e.getMessage());
                        status.setTextColor(getColor(R.color.aether_error));
                    });
                }
            });
        });
        dialog.show();
    }

    private ByokClient.Connection draft(ByokClient.Connection original, ByokClient.Provider selected,
                                        EditText name, EditText baseUrl, EditText apiKey, EditText models,
                                        EditText defaultModel, CheckBox enabled) {
        ByokClient.Connection c = original == null ? new ByokClient.Connection() : original.copy();
        c.provider = selected.id;
        c.name = name.getText().toString().trim();
        c.baseUrl = baseUrl.getText().toString().trim();
        c.apiKey = apiKey.getText().toString().trim();
        c.defaultModel = defaultModel.getText().toString().trim();
        c.enabled = enabled.isChecked();
        c.models.clear();
        c.models.addAll(splitModels(models.getText().toString()));
        return c;
    }

    private static List<String> splitModels(String raw) {
        Set<String> out = new LinkedHashSet<>();
        for (String line : raw.split("[\\n,]")) {
            String model = line.trim();
            if (!model.isEmpty()) out.add(model);
        }
        return new ArrayList<>(out);
    }

    private static String joinModels(List<String> models) {
        StringBuilder out = new StringBuilder();
        for (String model : models) {
            if (out.length() > 0) out.append('\n');
            out.append(model);
        }
        return out.toString();
    }

    private TextView fieldLabel(String text) {
        TextView label = Ui.tv(this, text, 12, Ui.PRIMARY);
        label.setPadding(0, Ui.dp(this, 10), 0, Ui.dp(this, 4));
        return label;
    }

    private EditText providerInput(String value, String hint) {
        EditText input = new EditText(this);
        input.setText(value);
        input.setHint(hint);
        input.setTextColor(getColor(R.color.aether_fg));
        input.setHintTextColor(getColor(R.color.aether_dim));
        input.setBackgroundResource(R.drawable.bg_field);
        input.setPadding(Ui.dp(this, 10), Ui.dp(this, 8), Ui.dp(this, 10), Ui.dp(this, 8));
        input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        return input;
    }

    private void toast(String text) {
        Toast.makeText(this, text == null ? "Provider operation failed." : text, Toast.LENGTH_LONG).show();
    }

    private interface SelectedListener { void selected(int position); }

    private static final class SimpleItemSelectedListener implements android.widget.AdapterView.OnItemSelectedListener {
        private final SelectedListener listener;
        SimpleItemSelectedListener(SelectedListener listener) { this.listener = listener; }
        @Override public void onItemSelected(android.widget.AdapterView<?> parent, View view, int position, long id) {
            listener.selected(position);
        }
        @Override public void onNothingSelected(android.widget.AdapterView<?> parent) { }
    }

    private static final class SimpleWatcher implements TextWatcher {
        private final Runnable changed;
        SimpleWatcher(Runnable changed) { this.changed = changed; }
        @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
        @Override public void onTextChanged(CharSequence s, int start, int before, int count) { changed.run(); }
        @Override public void afterTextChanged(Editable s) { }
    }
}
