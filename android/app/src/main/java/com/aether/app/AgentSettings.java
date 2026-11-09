package com.aether.app;

import android.content.Context;
import android.content.SharedPreferences;

/** Device-local agent generation preferences used by personal providers. */
final class AgentSettings {
    private static final String PREFS = "aether_agent";

    private AgentSettings() { }

    static ByokClient.ChatOptions load(Context context) {
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        ByokClient.ChatOptions o = new ByokClient.ChatOptions();
        o.instructions = p.getString("instructions", "");
        o.temperature = p.getFloat("temperature", 0.7f);
        if (Double.isNaN(o.temperature) || Double.isInfinite(o.temperature)) o.temperature = 0.7;
        o.maxTokens = p.getInt("maxTokens", 2048);
        o.timeoutMs = p.getInt("timeoutMs", 60_000);
        o.streaming = p.getBoolean("streaming", true);
        return o;
    }

    static void save(Context context, String instructions, double temperature, int maxTokens,
                     int timeoutMs, boolean streaming) {
        if (Double.isNaN(temperature) || Double.isInfinite(temperature)) temperature = 0.7;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("instructions", instructions == null ? "" : instructions)
                .putFloat("temperature", (float) Math.max(0, Math.min(2, temperature)))
                .putInt("maxTokens", Math.max(1, Math.min(32_768, maxTokens)))
                .putInt("timeoutMs", Math.max(10_000, Math.min(180_000, timeoutMs)))
                .putBoolean("streaming", streaming)
                .apply();
    }
}
