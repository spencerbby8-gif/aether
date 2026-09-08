package com.aether.app.core;

import com.aether.app.EngineCore;

import java.util.Locale;

/**
 * Plain language for a measured engine state.
 *
 * WHY THIS EXISTS. The engine rows used to print the raw evidence -- "/api/ps
 * 200 models=1", "HTTP 530", "no /api/ps answer", the kernel slug -- straight
 * into the row. That is machine output, and it buried the one thing the row
 * exists to answer: what state is this engine in. The raw text still exists,
 * behind Check now, for whoever is debugging; it is just no longer the default
 * view.
 *
 * Every string here is derived from a measurement that EngineCore already
 * made, so the wording can describe reality but cannot invent any. There is
 * deliberately no branch that guesses a phase.
 *
 * Kept in the pure-Java layer, not in the Activity, so the labels are covered
 * by EngineLabelsProof in the JVM suite -- an Activity cannot be instantiated
 * off a device, and untested user-facing strings are how "shows codes" happens.
 */
public final class EngineLabels {

    private EngineLabels() { }

    /** The one-word badge. Always a phase that was actually measured. */
    public static String badge(EngineCore.Phase p) {
        if (p == null) return "UNKNOWN";
        switch (p) {
            case LIVE:    return "LIVE";
            case WAKING:  return "WAKING";
            case OFF:     return "OFF";
            case QUOTA:   return "QUOTA";
            case ERROR:   return "ERROR";
            default:      return "UNKNOWN";
        }
    }

    /**
     * One sentence about the state, plus what it was measured on and when.
     * Null means nothing has been measured yet -- which is UNKNOWN, never OFF.
     */
    public static String humanLine(EngineCore.EngineState st, long nowMs) {
        if (st == null) return "Not checked yet";
        String age = st.verifiedAtMs == 0
                ? "" : "checked " + ago(nowMs - st.verifiedAtMs);
        String head;
        switch (st.phase) {
            case LIVE:
                head = "Ready to chat";
                break;
            case WAKING:
                head = "Starting up \u2014 takes a few minutes";
                break;
            case OFF:
                head = "Off \u2014 not holding a GPU";
                break;
            case QUOTA:
                head = "Kaggle refused to start it \u2014 limit reached";
                break;
            case ERROR:
                head = "Could not be reached";
                break;
            default:
                head = "Not checked yet";
                break;
        }
        String model = st.phase == EngineCore.Phase.LIVE && !st.models.isEmpty()
                ? shortModel(st.models.get(0)) : "";
        StringBuilder sb = new StringBuilder(head);
        if (!model.isEmpty()) sb.append("  \u00b7  ").append(model);
        if (!age.isEmpty()) sb.append("  \u00b7  ").append(age);
        return sb.toString();
    }

    /**
     * A model id people can read. The engines report a Hugging Face repo path
     * with a quant tag, which is not something to show on a phone screen.
     */
    public static String shortModel(String raw) {
        if (raw == null) return "";
        String s = raw.trim();
        int slash = s.lastIndexOf('/');
        if (slash >= 0 && slash < s.length() - 1) s = s.substring(slash + 1);
        int colon = s.indexOf(':');
        if (colon > 0) s = s.substring(0, colon);
        s = s.replace('-', ' ').replace('_', ' ').replaceAll("\\s+", " ").trim();
        if (s.toLowerCase(Locale.ROOT).endsWith(" gguf")) {
            s = s.substring(0, s.length() - 5).trim();
        }
        return s.length() > 24 ? s.substring(0, 24).trim() + "\u2026" : s;
    }

    /** How long ago the evidence was measured, in words. */
    public static String ago(long ms) {
        long s = ms / 1000;
        if (s < 0) s = 0;
        if (s < 5) return "just now";
        if (s < 60) return s + "s ago";
        long m = s / 60;
        if (m < 60) return m + "m ago";
        return (m / 60) + "h ago";
    }
}
