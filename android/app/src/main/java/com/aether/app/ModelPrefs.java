package com.aether.app;

import android.content.Context;

/** The public model choice; internal fleet slot selection is always AUTO. */
final class ModelPrefs {
    static final String AETHER = "aether";
    static final String BYOK = "byok";
    static final String AETHER_LABEL = "Aether Uncensored";

    private ModelPrefs() { }

    static String kind(Context context) {
        return context.getSharedPreferences("aether_console", Context.MODE_PRIVATE)
                .getString("model_kind", AETHER);
    }

    static String connectionId(Context context) {
        return context.getSharedPreferences("aether_console", Context.MODE_PRIVATE)
                .getString("byok_connection", "");
    }

    static String model(Context context) {
        return context.getSharedPreferences("aether_console", Context.MODE_PRIVATE)
                .getString("byok_model", "");
    }

    static void selectAether(Context context) {
        context.getSharedPreferences("aether_console", Context.MODE_PRIVATE).edit()
                .putString("model_kind", AETHER)
                .putString("mode", EngineRouter.AUTO)
                .remove("byok_connection").remove("byok_model").apply();
    }

    static void selectByok(Context context, String connectionId, String model) {
        context.getSharedPreferences("aether_console", Context.MODE_PRIVATE).edit()
                .putString("model_kind", BYOK)
                .putString("byok_connection", connectionId)
                .putString("byok_model", model).apply();
    }
}
