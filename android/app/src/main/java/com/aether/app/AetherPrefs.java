package com.aether.app;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.appcompat.app.AppCompatDelegate;

/** Device-local product preferences. No fleet or provider secrets live here. */
public final class AetherPrefs {
    private static final String PREFS = "aether_experience";

    private AetherPrefs() { }

    private static SharedPreferences p(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static boolean warmOnLaunch(Context c) { return p(c).getBoolean("warm_on_launch", true); }
    public static void warmOnLaunch(Context c, boolean value) { p(c).edit().putBoolean("warm_on_launch", value).apply(); }
    public static boolean animations(Context c) { return p(c).getBoolean("animations", true); }
    public static void animations(Context c, boolean value) { p(c).edit().putBoolean("animations", value).apply(); }
    public static boolean haptics(Context c) { return p(c).getBoolean("haptics", true); }
    public static void haptics(Context c, boolean value) { p(c).edit().putBoolean("haptics", value).apply(); }
    public static boolean sendOnEnter(Context c) { return p(c).getBoolean("send_on_enter", false); }
    public static void sendOnEnter(Context c, boolean value) { p(c).edit().putBoolean("send_on_enter", value).apply(); }
    public static boolean showActivity(Context c) { return p(c).getBoolean("show_activity", true); }
    public static void showActivity(Context c, boolean value) { p(c).edit().putBoolean("show_activity", value).apply(); }
    public static boolean expandSources(Context c) { return p(c).getBoolean("expand_sources", true); }
    public static void expandSources(Context c, boolean value) { p(c).edit().putBoolean("expand_sources", value).apply(); }
    public static boolean openLastChat(Context c) { return p(c).getBoolean("open_last_chat", false); }
    public static void openLastChat(Context c, boolean value) { p(c).edit().putBoolean("open_last_chat", value).apply(); }
    public static boolean discussion(Context c) { return p(c).getBoolean("discussion_default", false); }
    public static void discussion(Context c, boolean value) { p(c).edit().putBoolean("discussion_default", value).apply(); }
    public static boolean disclaimerSeen(Context c) { return p(c).getBoolean("disclaimer_seen", false); }
    public static void markDisclaimerSeen(Context c) { p(c).edit().putBoolean("disclaimer_seen", true).apply(); }
    public static long historyReset(Context c) { return p(c).getLong("history_reset", 0L); }
    public static void clearHistoryReset(Context c) { p(c).edit().remove("history_reset").apply(); }
    public static void requestHistoryReset(Context c) { p(c).edit().putLong("history_reset", System.currentTimeMillis()).apply(); }

    public static String responseStyle(Context c) { return p(c).getString("response_style", "Balanced"); }
    public static void responseStyle(Context c, String value) { p(c).edit().putString("response_style", value).apply(); }
    public static String theme(Context c) { return p(c).getString("theme", "Midnight"); }
    public static void applyTheme(Context c) {
        String value = theme(c);
        int mode = "Light".equals(value) ? AppCompatDelegate.MODE_NIGHT_NO
                : "System".equals(value) ? AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
                : AppCompatDelegate.MODE_NIGHT_YES;
        AppCompatDelegate.setDefaultNightMode(mode);
    }
    public static void theme(Context c, String value) {
        p(c).edit().putString("theme", value).apply();
        int mode = "Light".equals(value) ? AppCompatDelegate.MODE_NIGHT_NO
                : "System".equals(value) ? AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
                : AppCompatDelegate.MODE_NIGHT_YES;
        AppCompatDelegate.setDefaultNightMode(mode);
    }

    public static float textScale(Context c) { return p(c).getFloat("text_scale", 1f); }
    public static void textScale(Context c, float value) {
        p(c).edit().putFloat("text_scale", Math.max(.9f, Math.min(1.2f, value))).apply();
    }

    public static String instructions(Context c) {
        String style = responseStyle(c);
        String styleLine = "Concise".equals(style)
                ? "Keep answers brief and lead with the essential point."
                : "Detailed".equals(style)
                ? "Give useful context, concrete examples and complete explanations."
                : "Balance direct answers with enough detail to be useful.";
        String custom = AgentSettings.load(c).instructions;
        return styleLine + (custom == null || custom.trim().isEmpty() ? "" : "\n" + custom.trim());
    }

    public static String discussionInstructions(Context c) {
        return "Discussion mode is enabled. Focus on natural, direct conversation. "
                + "Do not search, browse, crawl, run commands, create files, or call tools. "
                + "Answer from the conversation and say when current information would need verification. "
                + instructions(c);
    }
}
