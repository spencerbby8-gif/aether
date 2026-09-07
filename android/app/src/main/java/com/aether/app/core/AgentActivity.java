package com.aether.app.core;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;

/**
 * Turns the engine's real agent events into short human activity labels.
 *
 * The kernel emits exactly these thinking events (read from the shipped
 * notebook, not guessed):
 *
 *   ⚙️ agent step N...                    one per agent iteration, at most 10
 *   ⏳                                     heartbeat, about every 10s
 *   🛠️ NAME(<json args, cut at 180 chars>) tool started
 *   ↳ NAME returned N chars                tool finished
 *   <the model's own reasoning text>       raw chain of thought
 *
 * Only the first four are operational facts about what Aether is doing. The
 * fifth is the model's private reasoning, and the tool line carries raw JSON
 * arguments; neither belongs in a conversation. So this class recognises the
 * operational events and DROPS everything else -- {@link #feed} returns false
 * for anything it does not understand, and the caller shows nothing.
 *
 * That is the whole rule against fabrication: no step exists here unless the
 * engine announced one. There is no timer that invents "Searching the web" and
 * no placeholder activity for a turn that is simply generating text.
 */
public final class AgentActivity {

    /** One thing Aether did, as the engine reported it. */
    public static final class Step {
        public final String tool;
        public final String label;      // "Searching the web"
        public final String detail;     // compact and human: a query, or a host
        public final String source;     // the URL this step read, when it read one
        public final long startMs;      // ms since the turn started
        public long durationMs;         // 0 while it is still running
        public int chars;               // from "returned N chars"
        public boolean done;

        Step(String tool, String label, String detail, String source, long startMs) {
            this.tool = tool;
            this.label = label;
            this.detail = detail;
            this.source = source;
            this.startMs = startMs;
        }

        public boolean running() { return !done; }

        public JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("tool", tool);
                o.put("label", label);
                o.put("start", startMs);
                o.put("dur", durationMs);
                if (detail != null && !detail.isEmpty()) o.put("detail", detail);
                if (source != null && !source.isEmpty()) o.put("source", source);
                if (chars > 0) o.put("chars", chars);
                o.put("done", done);
            } catch (Exception ignored) { }
            return o;
        }

        static Step fromJson(JSONObject o) {
            Step s = new Step(o.optString("tool", ""), o.optString("label", "Working"),
                    o.optString("detail", ""), o.optString("source", ""), o.optLong("start", 0));
            s.durationMs = o.optLong("dur", 0);
            s.chars = o.optInt("chars", 0);
            s.done = o.optBoolean("done", true);
            return s;
        }
    }

    /* The kernel's own tool table. Anything else is only accepted when it
       arrives with the 🛠 marker, so a stray word in the model's reasoning can
       never be mistaken for a tool call. */
    private static final String[] KNOWN = {
            "web_search", "fetch_page", "crawl_site", "run_command",
            "generate_image", "generate_voice",
    };

    private final List<Step> steps = new ArrayList<>();
    private final LinkedHashSet<String> sources = new LinkedHashSet<>();
    private final long t0 = System.currentTimeMillis();

    private int iteration;
    private long lastBeatAt;
    private boolean writing;
    private boolean finished;

    /** What the conversation should say right now, in one short line. */
    public String labelNow() {
        Step open = open();
        if (open != null) return open.label;
        if (writing) return "Writing";
        if (iteration > 0 || lastBeatAt > 0) return "Thinking";
        return "Working";
    }

    /** The step that is still running, or null. */
    public Step open() {
        for (int i = steps.size() - 1; i >= 0; i--) {
            if (!steps.get(i).done) return steps.get(i);
        }
        return null;
    }

    public List<Step> steps() { return steps; }

    public List<String> sources() { return new ArrayList<>(sources); }

    public boolean hasSteps() { return !steps.isEmpty(); }

    /** True once any real token of the answer has arrived. */
    public boolean isWriting() { return writing; }

    /**
     * Feed one raw thinking line exactly as the engine sent it. Returns true
     * when the line described something Aether is doing, false when it was the
     * model's reasoning or anything else that must not be shown.
     */
    public boolean feed(String raw) {
        if (raw == null) return false;
        String line = raw.trim();
        if (line.isEmpty()) return false;

        /* Heartbeat. Proof of life, not an activity: it keeps the current label
           honest without adding a row. */
        if (line.contains("\u23f3")) { lastBeatAt = now(); return true; }

        /* Agent iteration. Internal bookkeeping; it is what licenses "Thinking"
           before any tool runs, and it is never shown as text. */
        if (line.contains("agent step")) { iteration++; return true; }

        /* Tool finished: "↳ name returned N chars". */
        if (line.startsWith("\u21b3") || line.contains(" returned ")) {
            int at = line.indexOf(" returned ");
            if (at > 0) {
                String name = clean(line.substring(line.startsWith("\u21b3") ? 1 : 0, at));
                int n = digits(line.substring(at));
                Step s = latest(name);
                if (s != null) {
                    s.done = true;
                    s.durationMs = now() - s.startMs;
                    s.chars = n;
                }
                return true;
            }
        }

        /* Tool started: "🛠️ name({...})". */
        int paren = line.indexOf('(');
        if (paren > 0 && (line.contains("\ud83d\udee0") || isKnown(head(line, paren)))) {
            String name = clean(head(line, paren));
            String args = line.substring(paren + 1);
            int close = args.lastIndexOf(')');
            if (close >= 0) args = args.substring(0, close);
            Step s = new Step(name, labelFor(name), detailFor(name, args),
                    sourceFor(name, args), now());
            steps.add(s);
            if (s.source != null) sources.add(s.source);
            return true;
        }

        /* Everything else is the model's reasoning. Dropped on purpose. */
        return false;
    }

    /** The answer started arriving; the activity becomes "Writing". */
    public void noteContent() {
        writing = true;
        Step open = open();
        if (open != null) {          // a tool that never reported back
            open.done = true;
            open.durationMs = now() - open.startMs;
        }
    }

    /** The turn ended. Close anything still open so nothing looks stuck. */
    public void finish() {
        finished = true;
        Step open = open();
        if (open != null) {
            open.done = true;
            open.durationMs = now() - open.startMs;
        }
    }

    public boolean isFinished() { return finished; }

    /**
     * The collapsed line for a finished turn: what Aether actually did, in
     * plain words, with the elapsed time. Empty when it did nothing but answer.
     */
    public String summary() {
        if (steps.isEmpty()) return "";
        StringBuilder b = new StringBuilder();
        String last = null;
        int run = 0;
        for (Step s : steps) {
            String past = pastFor(s.tool);
            if (past.equals(last)) { run++; continue; }
            if (last != null) append(b, last + (run > 1 ? " \u00d7 " + (run + 1) : ""));
            last = past;
            run = 0;
        }
        if (last != null) append(b, last + (run > 1 ? " \u00d7 " + (run + 1) : ""));
        long total = 0;
        for (Step s : steps) total += s.durationMs;
        if (total > 0) append(b, (total / 1000) + "s");
        return b.toString();
    }

    public JSONArray toJson() {
        JSONArray a = new JSONArray();
        for (Step s : steps) a.put(s.toJson());
        return a;
    }

    public static List<Step> fromJson(JSONArray a) {
        List<Step> out = new ArrayList<>();
        if (a == null) return out;
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o != null) out.add(Step.fromJson(o));
        }
        return out;
    }

    // ------------------------------------------------------------- internals

    private long now() { return System.currentTimeMillis() - t0; }

    private Step latest(String name) {
        for (int i = steps.size() - 1; i >= 0; i--) {
            Step s = steps.get(i);
            if (!s.done && s.tool.equals(name)) return s;
        }
        return steps.isEmpty() ? null : steps.get(steps.size() - 1);
    }

    private static void append(StringBuilder b, String s) {
        if (b.length() > 0) b.append(" \u00b7 ");
        b.append(s);
    }

    private static int digits(String s) {
        StringBuilder n = new StringBuilder();
        for (char c : s.toCharArray()) {
            if (Character.isDigit(c)) n.append(c);
            else if (n.length() > 0) break;
        }
        try { return n.length() == 0 ? 0 : Integer.parseInt(n.toString()); }
        catch (Exception e) { return 0; }
    }

    private static String head(String line, int paren) {
        String h = line.substring(0, paren).trim();
        int sp = h.lastIndexOf(' ');
        return sp >= 0 ? h.substring(sp + 1) : h;
    }

    private static String clean(String s) {
        StringBuilder b = new StringBuilder();
        for (char c : s.trim().toCharArray()) {
            if (Character.isLetterOrDigit(c) || c == '_') b.append(c);
        }
        return b.toString();
    }

    private static boolean isKnown(String name) {
        for (String k : KNOWN) if (k.equals(name)) return true;
        return false;
    }

    /** The compact, human detail for a tool. Never the raw argument JSON. */
    private static String detailFor(String tool, String args) {
        if ("web_search".equals(tool)) return clip(text(args, "query"), 60);
        if ("fetch_page".equals(tool) || "crawl_site".equals(tool)) return host(text(args, "url"));
        if ("generate_image".equals(tool)) return clip(text(args, "prompt"), 48);
        /* run_command and generate_voice: the argument is a shell line or a
           paragraph of text. Neither reads as an activity, so no detail. */
        return "";
    }

    private static String sourceFor(String tool, String args) {
        if ("fetch_page".equals(tool) || "crawl_site".equals(tool)) {
            String u = text(args, "url");
            return u == null || u.isEmpty() ? null : u;
        }
        return null;
    }

    public static String labelFor(String tool) {
        switch (tool) {
            case "web_search":     return "Searching the web";
            case "fetch_page":     return "Reading a source";
            case "crawl_site":     return "Reading sources";
            case "run_command":    return "Running a command";
            case "generate_image": return "Generating an image";
            case "generate_voice": return "Generating audio";
            default:               return "Using a tool";
        }
    }

    private static String pastFor(String tool) {
        switch (tool) {
            case "web_search":     return "Searched the web";
            case "fetch_page":     return "Read a source";
            case "crawl_site":     return "Read sources";
            case "run_command":    return "Ran a command";
            case "generate_image": return "Generated an image";
            case "generate_voice": return "Generated audio";
            default:               return "Used a tool";
        }
    }

    /** Pull one string value out of an argument blob without parsing it whole:
        the kernel truncates arguments at 180 chars, so the JSON is often
        invalid and a strict parse would lose the detail entirely. */
    static String text(String args, String key) {
        if (args == null) return null;
        String needle = "\"" + key + "\"";
        int i = args.indexOf(needle);
        if (i < 0) return null;
        int colon = args.indexOf(':', i + needle.length());
        if (colon < 0) return null;
        int q = args.indexOf('"', colon + 1);
        if (q < 0) return null;
        StringBuilder b = new StringBuilder();
        for (int j = q + 1; j < args.length(); j++) {
            char c = args.charAt(j);
            if (c == '\\' && j + 1 < args.length()) {
                char n = args.charAt(++j);
                if (n == 'n') b.append(' ');
                else if (n != 'u') b.append(n);
                else j += 4;
                continue;
            }
            if (c == '"') break;
            b.append(c);
        }
        return b.toString().trim();
    }

    public static String host(String url) {
        if (url == null) return "";
        String u = url.replaceFirst("^https?://", "");
        int slash = u.indexOf('/');
        if (slash >= 0) u = u.substring(0, slash);
        return u.toLowerCase(Locale.ROOT);
    }

    public static String clip(String s, int max) {
        if (s == null) return "";
        s = s.replaceAll("\\s+", " ").trim();
        return s.length() <= max ? s : s.substring(0, max - 1).trim() + "\u2026";
    }
}
