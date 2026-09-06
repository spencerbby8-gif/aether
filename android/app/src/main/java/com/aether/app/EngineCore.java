package com.aether.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * The engine control layer. PURE JAVA, no android.* imports.
 *
 * That is the single most important design decision in this app. Everything the
 * APK needs in order to drive an engine is plain HTTPS, so keeping this class
 * free of Android means the IDENTICAL source file can be compiled with a stock
 * JDK and executed against the real Kaggle and ntfy endpoints. The build sandbox
 * has no /dev/kvm and no CPU virtualisation flags, so an Android emulator cannot
 * run there at all -- without this, the networking code would ship untested.
 *
 * Verified by scripts/proofs/engine-core-probe.sh, which compiles this file with
 * javac and runs it against the real Kaggle API, the real ntfy topic and a live
 * engine (/api/ps, /off with and without the key, /api/chat NDJSON streaming).
 *
 * Credentials are passed in, never read from globals, and never logged. Every
 * exception message avoids echoing a key.
 *
 * FOUR BUGS IN THIS FILE WERE FOUND BY RUNNING THE REAL ENGINE, not by reading
 * it. Each is documented at the point it was fixed, because each one produced a
 * result that looked like success.
 */
public final class EngineCore {

    public static final String KAGGLE_API = "https://www.kaggle.com/api/v1";
    public static final String NTFY_BASE = "https://ntfy.sh/";

    /**
     * The title MUST be this exact string.
     *
     * Kaggle derives a kernel's slug from its title, and the slug is how the
     * kernel is addressed afterwards. A per-engine title such as "Aether engine A"
     * renames the kernel and moves it to /aether-engine-a, after which every
     * status lookup against the real slug returns 404 -- to a perfectly valid
     * key. This is not hypothetical: it happened, and the probe caught it.
     * src/server/engine/resolve.ts:47 uses this same constant, which slugifies to
     * qwen-3-8-27b-uncensored-chat.
     */
    public static final String KERNEL_TITLE = "Qwen 3.8 27B Uncensored Chat";

    private EngineCore() {}

    public static final class EngineException extends Exception {
        public final int status;
        public EngineException(String message, int status) { super(message); this.status = status; }
        public EngineException(String message, Throwable cause) { super(message, cause); this.status = -1; }
    }

    /** One of the three engines: a slot letter plus the Kaggle account owning it. */
    public static final class Engine {
        public final String slot;
        public final String user;
        public final String key;
        public final String kernelSlug;
        public Engine(String slot, String user, String key, String kernelSlug) {
            this.slot = slot; this.user = user; this.key = key; this.kernelSlug = kernelSlug;
        }
        /** Safe for logs: deliberately never includes the key. */
        @Override public String toString() { return slot.toUpperCase() + "/" + user; }
    }

    /** A tunnel URL seen on the beacon. */
    public static final class LiveLink {
        public final String url;
        public final String slot;
        public final long ageSeconds;
        LiveLink(String url, String slot, long ageSeconds) {
            this.url = url; this.slot = slot; this.ageSeconds = ageSeconds;
        }
        @Override public String toString() {
            return (slot == null ? "?" : slot) + " -> " + url + " (" + ageSeconds + "s old)";
        }
    }

    /** Result of a health probe. LIVE requires a 200 AND a non-empty models[]. */
    public static final class Health {
        public final int status;
        public final List<String> models;
        Health(int status, List<String> models) { this.status = status; this.models = models; }
        public boolean isLive() { return status == 200 && !models.isEmpty(); }
    }

    // ------------------------------------------------------------------ HTTP

    private static final class Response {
        final int status; final String body;
        Response(int status, String body) { this.status = status; this.body = body; }
    }

    private static HttpURLConnection open(String method, String url, int timeoutMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(timeoutMs);
        c.setReadTimeout(timeoutMs);
        c.setInstanceFollowRedirects(true);
        /* Keep-alive is the default and matters here: the engine desync bug this
           contract was hardened against only shows up on a reused socket, so a
           client that did not reuse them would not behave like a real client. */
        c.setRequestProperty("Connection", "keep-alive");
        return c;
    }

    private static Response http(String method, String url, String body, String contentType,
                                 String authHeader, int timeoutMs) throws EngineException {
        HttpURLConnection c = null;
        try {
            c = open(method, url, timeoutMs);
            if (authHeader != null) c.setRequestProperty("Authorization", authHeader);
            if (contentType != null) c.setRequestProperty("Content-Type", contentType);
            if (body != null) {
                c.setDoOutput(true);
                byte[] out = body.getBytes(StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(out.length);
                try (OutputStream os = c.getOutputStream()) { os.write(out); }
            }
            int status = c.getResponseCode();
            InputStream is = (status >= 400) ? c.getErrorStream() : c.getInputStream();
            StringBuilder sb = new StringBuilder();
            if (is != null) {
                try (BufferedReader r = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = r.readLine()) != null) sb.append(line).append('\n');
                }
            }
            return new Response(status, sb.toString());
        } catch (Exception e) {
            throw new EngineException(method + " " + hostOf(url) + " failed: " + e.getMessage(), e);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String hostOf(String url) {
        try { return new URL(url).getHost(); } catch (Exception e) { return url; }
    }

    // ---------------------------------------------------------------- Kaggle

    /**
     * Kernel state: "error" | "queued" | "running".
     *
     * "error" is Kaggle's resting state for a kernel that is simply not running,
     * NOT a failure -- treating it as one makes every idle engine look broken.
     *
     * KGAT_ tokens authenticate with `Authorization: Bearer`. HTTP Basic returns
     * 401 for them even with a valid key, identical to a revoked one. That is a
     * real trap and the probe demonstrates both returning 401.
     */
    public static String kernelStatus(Engine e, int timeoutMs) throws EngineException {
        String url = KAGGLE_API + "/kernels/status?userName=" + enc(e.user)
                + "&kernelSlug=" + enc(e.kernelSlug);
        Response r = http("GET", url, null, null, "Bearer " + e.key, timeoutMs);
        if (r.status == 401) throw new EngineException("Kaggle rejected the key for engine "
                + e.slot.toUpperCase() + " (401).", 401);
        if (r.status == 403) throw new EngineException("Kaggle refused engine "
                + e.slot.toUpperCase() + " (403): the key may not own this kernel.", 403);
        if (r.status == 429) throw new EngineException("Kaggle rate-limited engine "
                + e.slot.toUpperCase() + " (429).", 429);
        if (r.status == 404) throw new EngineException("Kaggle has no kernel at "
                + e.user + "/" + e.kernelSlug + " (404) -- a push with the wrong title will do this.", 404);
        if (r.status != 200) throw new EngineException("Kaggle status HTTP " + r.status, r.status);
        try {
            return new JSONObject(r.body).optString("status", "unknown");
        } catch (Exception ex) {
            throw new EngineException("Unparseable Kaggle status: " + trim(r.body), ex);
        }
    }

    /**
     * Push the notebook -- this is what actually starts a kernel.
     *
     * `text` must be a fully rendered notebook. Never a stub: a stub push silently
     * replaces a working engine with one that cannot serve, and Kaggle accepts it
     * happily.
     */
    public static String kernelPush(Engine e, String notebookJson, String title,
                                    boolean gpu, int timeoutMs) throws EngineException {
        if (notebookJson == null || notebookJson.length() < 1000) {
            throw new EngineException("Refusing to push a notebook of "
                    + (notebookJson == null ? 0 : notebookJson.length())
                    + " bytes -- that is a stub, not an engine.", -1);
        }
        if (title != null && !KERNEL_TITLE.equals(title)) {
            throw new EngineException("Refusing to push with title \"" + title
                    + "\": it would rename the kernel and orphan its slug. Use KERNEL_TITLE.", -1);
        }
        JSONObject body = new JSONObject();
        try {
            body.put("slug", e.user + "/" + e.kernelSlug);
            body.put("newTitle", KERNEL_TITLE);
            body.put("text", notebookJson);
            body.put("language", "python");
            body.put("kernelType", "notebook");
            body.put("isPrivate", true);
            body.put("enableGpu", gpu);
            body.put("enableInternet", true);
        } catch (Exception ex) {
            throw new EngineException("Could not build the push body", ex);
        }
        Response r = http("POST", KAGGLE_API + "/kernels/push", body.toString(),
                "application/json", "Bearer " + e.key, timeoutMs);
        if (r.status == 401) throw new EngineException("Kaggle rejected the key for engine "
                + e.slot.toUpperCase() + " (401).", 401);
        if (r.status == 429) throw new EngineException("Kaggle rate-limited the push for engine "
                + e.slot.toUpperCase() + " (429).", 429);
        if (r.status < 200 || r.status >= 300) {
            throw new EngineException("Kaggle push HTTP " + r.status + ": " + trim(r.body), r.status);
        }
        return trim(r.body);
    }

    // ---------------------------------------------------------------- Beacon

    private static final Pattern LIVE_RE =
            Pattern.compile("(?:AGENT LIVE LINK|alive)[:\\s]+(https?://[^\\s)]+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern TAG_RE =
            Pattern.compile("engine\\s*[:=]?\\s*([abc])\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern SIG_RE =
            Pattern.compile("(?:\\bsig=|X-Aether-Sig:\\s*)([a-f0-9]{64})", Pattern.CASE_INSENSITIVE);

    /** HMAC-SHA256, matching src/server/engine/beacon.ts. */
    public static String sign(String payload, String secret) throws EngineException {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            StringBuilder sb = new StringBuilder();
            for (byte b : mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)))
                sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            throw new EngineException("HMAC failed", e);
        }
    }

    /** Verify an announcement. With no secret configured, everything is accepted. */
    public static boolean verify(String text, String secret) {
        if (secret == null || secret.isEmpty()) return true;
        Matcher m = SIG_RE.matcher(text);
        if (!m.find()) return false;
        String provided = m.group(1).toLowerCase();
        String expected;
        try {
            expected = sign(SIG_RE.matcher(text).replaceAll("").trim(), secret);
        } catch (EngineException e) {
            return false;
        }
        return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                provided.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Live links from an ntfy topic, newest first per URL.
     *
     * A topic accumulates a URL from every boot, and a dead Cloudflare tunnel
     * answers 530 -- so a stale URL looks identical to a live one until it is
     * probed. Deciding which one is CURRENT is {@link #currentLinkFor}.
     */
    public static List<LiveLink> liveLinks(String topic, String secret, int sinceSeconds,
                                           int timeoutMs) throws EngineException {
        String url = NTFY_BASE + enc(topic) + "/json?poll=1&since=" + sinceSeconds + "s";
        Response r = http("GET", url, null, null, null, timeoutMs);
        if (r.status != 200) throw new EngineException("ntfy HTTP " + r.status, r.status);

        long now = System.currentTimeMillis() / 1000L;
        List<LiveLink> sightings = new ArrayList<>();
        for (String line : r.body.split("\n")) {
            line = line.trim();
            if (line.isEmpty()) continue;
            String msg; long at;
            try {
                JSONObject o = new JSONObject(line);
                msg = o.optString("message", "");
                at = o.optLong("time", 0L);
            } catch (Exception e) {
                continue;  // ntfy emits non-JSON keepalives
            }
            if (msg.isEmpty() || !verify(msg, secret)) continue;
            Matcher lm = LIVE_RE.matcher(msg);
            if (!lm.find()) continue;
            String link = lm.group(1).replaceAll("[.,;]+$", "");
            Matcher tm = TAG_RE.matcher(msg);
            sightings.add(new LiveLink(link, tm.find() ? tm.group(1).toLowerCase() : null, now - at));
        }

        /* BUG FOUND LIVE: an attributed sighting must beat an unattributed one
           REGARDLESS of age. Checking recency first drops the tag for exactly
           the engines that are up, because a running engine's most recent
           announcement is its idle heartbeat. Observed on the real topic: 2
           links, 0 tagged, although both AGENT LIVE LINK lines said engine=a.
           (The engine now tags its heartbeat too, but old announcements are
           still on the topic and a client should not depend on that.) */
        Map<String, LiveLink> best = new LinkedHashMap<>();
        for (LiveLink l : sightings) {
            LiveLink cur = best.get(l.url);
            if (cur == null
                    || (cur.slot == null && l.slot != null)
                    || ((cur.slot != null) == (l.slot != null) && l.ageSeconds < cur.ageSeconds)) {
                best.put(l.url, l);
            }
        }
        List<LiveLink> out = new ArrayList<>(best.values());
        out.sort((x, y) -> Long.compare(x.ageSeconds, y.ageSeconds));
        return out;
    }

    /**
     * The URL to actually use for a slot, or null.
     *
     * Walks the candidates newest-first and returns the first that is genuinely
     * LIVE. This is what discards stale URLs instead of showing them.
     */
    public static String currentLinkFor(String topic, String secret, String slot,
                                        int sinceSeconds, int timeoutMs) throws EngineException {
        for (LiveLink l : liveLinks(topic, secret, sinceSeconds, timeoutMs)) {
            if (l.slot != null && !l.slot.equals(slot)) continue;   // belongs to another engine
            if (health(l.url, timeoutMs).isLive()) return l.url;
        }
        return null;
    }

    // ---------------------------------------------------------------- Engine

    /**
     * Health. LIVE means 200 AND at least one loaded model -- a kernel answers
     * /api/ps with an empty models[] while the weights are still loading, and
     * showing LIVE at that point sends the user into a chat that cannot answer.
     */
    public static Health health(String url, int timeoutMs) {
        try {
            Response r = http("GET", join(url, "/api/ps"), null, null, null, timeoutMs);
            List<String> models = new ArrayList<>();
            if (r.status == 200) {
                try {
                    JSONArray arr = new JSONObject(r.body).optJSONArray("models");
                    if (arr != null) {
                        for (int i = 0; i < arr.length(); i++) {
                            String n = arr.optJSONObject(i).optString("name", "");
                            if (!n.isEmpty()) models.add(n);
                        }
                    }
                } catch (Exception ignored) { }
            }
            return new Health(r.status, models);
        } catch (EngineException e) {
            return new Health(-1, new ArrayList<>());
        }
    }

    /** Kill switch without the key -- exists so the gate can be proven to reject it. */
    public static int offNoKey(String url, int timeoutMs) throws EngineException {
        Response r = http("POST", join(url, "/off"), "{}", "application/json", null, timeoutMs);
        return r.status;
    }

    /** Kill switch with the key the engine's POST routes are gated on. */
    public static int off(String url, String offKey, int timeoutMs) throws EngineException {
        HttpURLConnection c = null;
        try {
            c = open("POST", join(url, "/off"), timeoutMs);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("X-Engine-Key", offKey);
            c.setDoOutput(true);
            byte[] out = "{}".getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(out.length);
            try (OutputStream os = c.getOutputStream()) { os.write(out); }
            int code = c.getResponseCode();
            InputStream is = (code >= 400) ? c.getErrorStream() : c.getInputStream();
            if (is != null) is.close();
            return code;
        } catch (Exception e) {
            throw new EngineException("POST /off failed: " + e.getMessage(), e);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /**
     * Confirm an engine is really gone before anything reports OFF.
     *
     * A 200 from /off only means the request was accepted; the kernel then shuts
     * itself down. Measured live: /api/ps went 200 -> 502 -> 530 over ~24s, while
     * Kaggle's own kernel status still read "running" the whole time. Claiming OFF
     * on the strength of the 200 would report an engine as off while it still
     * holds a GPU.
     */
    public static boolean confirmedDown(String url, int attempts, int gapMs, int timeoutMs) {
        for (int i = 0; i < attempts; i++) {
            if (!health(url, timeoutMs).isLive()) return true;
            try { Thread.sleep(gapMs); } catch (InterruptedException e) { return false; }
        }
        return !health(url, timeoutMs).isLive();
    }

    // ------------------------------------------------------- chat streaming

    /** Receives streamed tokens. Called on the network thread. */
    public interface ChatListener {
        void onThinking(String text);
        void onContent(String text);
        void onDone(boolean ok, String error);
    }

    /**
     * Stream a chat turn as NDJSON.
     *
     * THE WIRE FORMAT IS OLLAMA'S, and guessing it wrong fails silently:
     *
     *   {"message": {"thinking": "..."}, "done": false}
     *   {"message": {"content": "..."},  "done": false}
     *   {"message": {"content": ""}, "done": true, "done_reason": "stop", ...}
     *
     * There is no "type" field and no "text" field. A parser written against
     * those reads every line, matches nothing, and reports a clean empty success.
     *
     * DO NOT SEND A "model" FIELD. The engine builds its ollama payload as
     * user_payload.get('model', MODEL), so a client-supplied model name OVERRIDES
     * the one actually loaded in VRAM. Sending "aether" makes it ask ollama for a
     * model that does not exist, and the engine answers
     * {"content":"(model timeout/error)"} with done:true -- a well-formed stream
     * that looks like a successful empty reply. Measured: 181ms to first token,
     * 1 chunk, 21 chars, all of it that error string.
     *
     * `cancel` is polled between lines, so stopping actually closes the socket
     * rather than letting the generation finish in the background.
     */
    public static void chatStream(String url, String offKey, String prompt, String system,
                                  boolean[] cancelledFlag, ChatListener listener, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            JSONObject body = new JSONObject();
            body.put("stream", true);
            JSONArray msgs = new JSONArray();
            /* No "role":"system" wrapper object -- the engine's contract does not
               use one. System text rides as a leading user message. */
            if (system != null && !system.isEmpty()) {
                msgs.put(new JSONObject().put("role", "user").put("content", system));
            }
            msgs.put(new JSONObject().put("role", "user").put("content", prompt));
            body.put("messages", msgs);

            c = open("POST", join(url, "/api/chat"), timeoutMs);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Accept", "application/x-ndjson");
            c.setRequestProperty("X-Engine-Key", offKey);
            c.setDoOutput(true);
            byte[] out = body.toString().getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(out.length);
            try (OutputStream os = c.getOutputStream()) { os.write(out); }

            int status = c.getResponseCode();
            if (status != 200) {
                listener.onDone(false, "chat HTTP " + status);
                return;
            }
            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    if (cancelledFlag != null && cancelledFlag[0]) {
                        listener.onDone(false, "cancelled");
                        return;
                    }
                    line = line.trim();
                    if (line.isEmpty()) continue;
                    JSONObject o;
                    try { o = new JSONObject(line); } catch (Exception e) { continue; }

                    if (o.optBoolean("done", false)) {
                        listener.onDone(true, null);
                        return;
                    }
                    JSONObject msg = o.optJSONObject("message");
                    if (msg == null) continue;
                    String thinking = msg.optString("thinking", "");
                    if (!thinking.isEmpty()) listener.onThinking(thinking);
                    String content = msg.optString("content", "");
                    if (!content.isEmpty()) listener.onContent(content);
                }
                listener.onDone(true, null);
            }
        } catch (Exception e) {
            listener.onDone(false, e.getMessage() == null ? "stream failed" : e.getMessage());
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ----------------------------------------------------------------- utils

    private static String join(String base, String path) {
        return base.replaceAll("/+$", "") + path;
    }

    private static String enc(String s) {
        try { return java.net.URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return s; }
    }

    private static String trim(String s) {
        if (s == null) return "";
        s = s.trim();
        return s.length() > 240 ? s.substring(0, 240) + "…" : s;
    }
}
