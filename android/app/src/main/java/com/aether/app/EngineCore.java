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
        return open(method, url, timeoutMs, timeoutMs);
    }

    /**
     * Connect and read timeouts are separate on purpose. A streaming turn needs
     * a SHORT read timeout so the reader surfaces regularly and the caller can
     * notice a cancellation or a dead connection; a long one turns both into a
     * ten-minute freeze.
     */
    private static HttpURLConnection open(String method, String url, int connectMs, int readMs)
            throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(connectMs);
        c.setReadTimeout(readMs);
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
            if (health(url, timeoutMs).status != 200) return true;
            try { Thread.sleep(gapMs); } catch (InterruptedException e) { return false; }
        }
        return health(url, timeoutMs).status != 200;
    }

    /** What a shutdown attempt actually observed. Every field is measured. */
    public static final class Shutdown {
        public final int code;           // HTTP status returned by POST /off
        public final boolean confirmed;  // /api/ps stopped answering with 200
        public final int checks;         // how many /api/ps checks that took
        public final int finalStatus;    // last status seen (-1 = unreachable)
        public final String message;
        Shutdown(int code, boolean confirmed, int checks, int finalStatus, String message) {
            this.code = code; this.confirmed = confirmed; this.checks = checks;
            this.finalStatus = finalStatus; this.message = message;
        }
    }

    /**
     * Shut one engine down and verify it, in a single call.
     *
     * "Down" means /api/ps no longer answers 200 -- the kernel process and its
     * tunnel are gone. It deliberately does NOT mean "no models loaded": an
     * engine that is still booting answers 200 with an empty models list, and
     * treating that as down reported a running, GPU-holding engine as
     * terminated. That was a live bug in confirmedDown() and in the Settings
     * shutdown path, which both tested !isLive().
     */
    public static Shutdown shutDownVerified(String url, String offKey, int timeoutMs,
                                            int maxChecks, int gapMs) throws EngineException {
        int code = off(url, offKey, timeoutMs);
        if (code != 200) {
            return new Shutdown(code, false, 0, -1,
                    "shutdown not accepted: POST /off returned HTTP " + code);
        }
        int status = -1;
        for (int i = 1; i <= maxChecks; i++) {
            status = health(url, timeoutMs).status;
            if (status != 200) {
                return new Shutdown(code, true, i, status,
                        "off -- confirmed terminated (/api/ps now " + status + " after "
                                + i + " check" + (i > 1 ? "s" : "") + ")");
            }
            try { Thread.sleep(gapMs); } catch (InterruptedException ie) { break; }
        }
        return new Shutdown(code, false, maxChecks, status,
                "shutdown sent but /api/ps STILL answers 200 after " + maxChecks
                        + " checks -- the engine is not off");
    }

    /**
     * Every distinct tunnel one slot has announced in the window, newest first.
     *
     * Kaggle keeps previous versions of a kernel running when a new one is
     * pushed, and there is no API to stop them (kaggle-api issue #388: "when I
     * push a new kernel all other versions keep running"). Each running version
     * opens its OWN tunnel and announces it, so "the newest URL" is not "the
     * engine": shutting down only that one leaves the others holding GPUs, which
     * reads exactly as "it won't turn off". Observed live -- two distinct
     * engine-A tunnels answering /api/ps 200 within the same minute.
     */
    public static List<String> urlsFor(String topic, String secret, String slot,
                                       int sinceSeconds, int timeoutMs, int limit)
            throws EngineException {
        List<String> out = new ArrayList<>();
        for (LiveLink l : liveLinks(topic, secret, sinceSeconds, timeoutMs)) {
            if (!slot.equals(l.slot)) continue;
            if (!out.contains(l.url)) out.add(l.url);
            if (out.size() >= limit) break;
        }
        return out;
    }

    // ------------------------------------------------- engine status truth

    /** Sentinel: no /api/ps check was possible, because no tunnel answered. */
    public static final int NO_CHECK = Integer.MIN_VALUE;

    /**
     * The only phases the UI is allowed to show, and the evidence each needs.
     *
     *   LIVE    /api/ps returned 200 WITH at least one loaded model. Nothing
     *           else earns this label -- not a beacon announcement, not a
     *           successful push, not "selected".
     *   WAKING  a real request is in progress: a push was accepted, Kaggle says
     *           queued/running, or the kernel answers 200 with no model yet.
     *   OFF     nothing answers /api/ps AND Kaggle reports the kernel gone.
     *   QUOTA   Kaggle refused a push for quota or limits.
     *   ERROR   an operation the user just triggered actually failed. NEVER a
     *           stale tunnel: an old Cloudflare URL answering 530, or failing
     *           DNS with -1, says nothing about the engine and must not be
     *           shown as an error.
     */
    public enum Phase { LIVE, WAKING, OFF, QUOTA, ERROR, UNKNOWN }

    /** An operation the user just triggered. This is what ERROR is allowed to mean. */
    public static final class Action {
        public final String what;
        public final boolean ok;
        public final boolean quota;
        public final String detail;
        private Action(String what, boolean ok, boolean quota, String detail) {
            this.what = what; this.ok = ok; this.quota = quota; this.detail = detail;
        }
        public static Action succeeded(String what, String detail) {
            return new Action(what, true, false, detail);
        }
        public static Action failed(String what, String detail) {
            return new Action(what, false, false, detail);
        }
        public static Action quotaHit(String what, String detail) {
            return new Action(what, false, true, detail);
        }
    }

    /**
     * One engine's state, derived only from evidence that was actually measured.
     *
     * `detail` is scrubbed of URLs on the way in, so a tunnel hostname cannot
     * reach the screen even if a caller builds one by accident. `url` is for the
     * caller's own routing and must never be rendered.
     */
    public static final class EngineState {
        public final String slot;
        public final Phase phase;
        public final String detail;
        public final String url;
        public final long verifiedAtMs;      // 0 = /api/ps was never checked
        public final List<String> models;
        public final String kaggleStatus;    // null when it was not consulted

        EngineState(String slot, Phase phase, String detail, String url,
                    long verifiedAtMs, List<String> models, String kaggleStatus) {
            this.slot = slot;
            this.phase = phase;
            this.detail = scrubUrls(detail);
            this.url = url;
            this.verifiedAtMs = verifiedAtMs;
            this.models = models == null ? new ArrayList<>() : models;
            this.kaggleStatus = kaggleStatus;
        }

        public boolean isLive() { return phase == Phase.LIVE; }
    }

    /** Strip anything that looks like a URL. The UI must never show a tunnel. */
    public static String scrubUrls(String s) {
        if (s == null) return "";
        return s.replaceAll("(?i)\\b[a-z][a-z0-9+.-]*://\\S+", "[engine endpoint hidden]")
                .replaceAll("(?i)\\b[a-z0-9-]+\\.trycloudflare\\.com\\b", "[engine endpoint hidden]");
    }

    /**
     * Classify one engine. THE ORDER IS THE POINT: a real /api/ps answer beats
     * everything; when nothing answers, Kaggle's own kernel status decides
     * between WAKING and OFF; ERROR only ever comes from an action that failed.
     *
     * @param healthStatus status from a /api/ps check just performed, or NO_CHECK
     * @param models       what that check returned
     * @param url          the tunnel that was checked, if any
     * @param kaggleStatus Kaggle's kernel status, or null if not consulted
     * @param action       the operation just triggered, or null
     */
    public static EngineState classify(String slot, int healthStatus, List<String> models,
                                       String url, String kaggleStatus, Action action) {
        return classify(slot, healthStatus, models, url, kaggleStatus, action, 0L);
    }

    /**
     * Same, but able to weigh a shutdown this client confirmed itself.
     *
     * `confirmedOffAtMs` is the wall-clock time at which /api/ps was watched
     * stopping. That is a measurement taken at the engine, so it outranks
     * Kaggle's kernel status, which is a control-plane field that lags: observed
     * reading "running" for minutes after the process had died. Without this, a
     * confirmed shutdown was reported OFF for one frame and then flipped back to
     * WAKING on the next poll. It is placed after the /api/ps checks, so an
     * engine that genuinely came back is still shown LIVE.
     */
    public static EngineState classify(String slot, int healthStatus, List<String> models,
                                       String url, String kaggleStatus, Action action,
                                       long confirmedOffAtMs) {
        long now = System.currentTimeMillis();
        List<String> m = models == null ? new ArrayList<>() : models;

        // 1. Measured evidence from the engine itself.
        if (healthStatus == 200 && !m.isEmpty()) {
            return new EngineState(slot, Phase.LIVE, "live — " + String.join(", ", m),
                    url, now, m, kaggleStatus);
        }
        if (healthStatus == 200) {
            return new EngineState(slot, Phase.WAKING,
                    "waking — kernel answers /api/ps, model not loaded yet", url, now, m, kaggleStatus);
        }

        // 2. A shutdown confirmed at the engine beats Kaggle's lagging status.
        if (confirmedOffAtMs > 0) {
            return new EngineState(slot, Phase.OFF,
                    "off — shutdown confirmed at the engine (/api/ps stopped answering)"
                            + "; Kaggle's own status still reads \""
                            + (kaggleStatus == null || kaggleStatus.isEmpty() ? "unknown" : kaggleStatus)
                            + "\"",
                    url, confirmedOffAtMs, m, kaggleStatus);
        }

        // 3. Nothing answers. A dead tunnel is not an error: 530 and -1 are what
        //    an old Cloudflare URL returns once the engine is gone.
        if (action != null && action.quota) {
            return new EngineState(slot, Phase.QUOTA, action.what + " refused by Kaggle: "
                    + action.detail, url, 0, m, kaggleStatus);
        }
        if (action != null && !action.ok) {
            return new EngineState(slot, Phase.ERROR, action.what + " failed: "
                    + action.detail, url, 0, m, kaggleStatus);
        }
        String kg = kaggleStatus == null ? "" : kaggleStatus.trim().toLowerCase(java.util.Locale.ROOT);
        if (action != null && action.ok) {
            return new EngineState(slot, Phase.WAKING, "waking — " + action.detail,
                    url, 0, m, kaggleStatus);
        }
        switch (kg) {
            case "queued":
                return new EngineState(slot, Phase.WAKING,
                        "waking — queued for a GPU", url, 0, m, kaggleStatus);
            case "running":
                return new EngineState(slot, Phase.WAKING,
                        "waking — kernel running, engine not answering yet", url, 0, m, kaggleStatus);
            case "":
                return new EngineState(slot, Phase.OFF,
                        "off — nothing answering and Kaggle has no kernel state",
                        url, 0, m, kaggleStatus);
            case "error":
                return new EngineState(slot, Phase.OFF,
                        "off — nothing answering, Kaggle reports the kernel terminated",
                        url, 0, m, kaggleStatus);
            default:
                return new EngineState(slot, Phase.OFF,
                        "off — nothing answering, Kaggle reports \"" + kaggleStatus + "\"",
                        url, 0, m, kaggleStatus);
        }
    }

    /** True when a push failure is a quota or limit refusal, not a real fault. */
    public static boolean isQuotaRefusal(int status, String body) {
        if (status == 429) return true;
        if (body == null) return false;
        String b = body.toLowerCase(java.util.Locale.ROOT);
        return b.contains("quota") || b.contains("weekly limit") || b.contains("rate limit")
                || b.contains("gpu limit") || b.contains("exceeded");
    }

    /** The outcome of shutting down every running instance of one engine. */
    public static final class ShutdownAll {
        public final int checked;        // tunnels examined
        public final int killed;         // confirmed terminated
        public final int alreadyDead;    // not answering when examined
        public final int stillUp;        // accepted /off and kept answering
        public final boolean allDown;
        public final String message;
        ShutdownAll(int checked, int killed, int alreadyDead, int stillUp, String message) {
            this.checked = checked; this.killed = killed; this.alreadyDead = alreadyDead;
            this.stillUp = stillUp; this.message = message;
            this.allDown = stillUp == 0;
        }
    }

    /**
     * Shut down EVERY tunnel an engine has announced, and say how many there were.
     *
     * Killing only the newest one is not enough: Kaggle leaves earlier kernel
     * versions running after a push and has no API to stop them, so one engine
     * can have several tunnels holding several GPUs. Tunnels that are already
     * dead are counted separately, because /off there returns 530 and would
     * otherwise be miscounted as a failed shutdown.
     */
    public static ShutdownAll shutDownEvery(List<String> urls, String offKey, int timeoutMs,
                                            int maxChecks, int gapMs) throws EngineException {
        int killed = 0, dead = 0, up = 0;
        String lastFailure = "";
        for (String url : urls) {
            if (health(url, timeoutMs).status != 200) { dead++; continue; }
            Shutdown s = shutDownVerified(url, offKey, timeoutMs, maxChecks, gapMs);
            if (s.confirmed) killed++;
            else { up++; lastFailure = s.message; }
        }
        String message;
        if (up > 0) {
            message = up + " of " + urls.size() + " instances still answering -- " + lastFailure;
        } else if (killed == 0) {
            message = "nothing was running to shut down";
        } else {
            message = killed + " running instance" + (killed == 1 ? "" : "s")
                    + " confirmed terminated"
                    + (dead > 0 ? " (" + dead + " stale tunnel" + (dead == 1 ? "" : "s")
                            + " already dead)" : "");
        }
        return new ShutdownAll(urls.size(), killed, dead, up, message);
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
    /**
     * Timing policy for one streamed turn.
     *
     * The numbers come from the engine's own behaviour, not from guesswork:
     * while the model generates, the engine emits an {"message":{"thinking":"..."} }
     * heartbeat roughly every 10 seconds, and a tool call (run_command,
     * web_search, crawl) executes synchronously and emits nothing until it
     * returns -- those are bounded by the engine's own subprocess timeouts, the
     * longest of which is 300s. So:
     *
     *   readSliceMs  how often the reader surfaces. Bounds how long "stop" can
     *                take to be noticed, and how often a stall is detected.
     *   stallMs      no bytes at all for this long means the tunnel or the
     *                kernel is gone. MUST sit above the longest silent tool run
     *                or a legitimate tool call is cut off mid-turn. Read from
     *                the kernel source, not guessed: the heartbeat loop only
     *                wraps the model call (`while tw.is_alive(): emit('⏳');
     *                tw.join(10)`), while tool execution emits nothing until it
     *                returns, and the kernel's own subprocess timeouts run to
     *                1200s. The shipped 330s was below that, so a long crawl or
     *                command killed the turn -- the "stuck on generating" case.
     *   totalMs      wall-clock ceiling. Ten model iterations, each able to run
     *                a tool, so this is generous; it exists so a turn can never
     *                hang for ever, not to limit how long the agent may think.
     */
    public static final class StreamPolicy {
        public final int connectMs;
        public final int readSliceMs;
        public final int stallMs;
        public final int totalMs;

        public StreamPolicy(int connectMs, int readSliceMs, int stallMs, int totalMs) {
            this.connectMs = connectMs;
            this.readSliceMs = readSliceMs;
            this.stallMs = stallMs;
            this.totalMs = totalMs;
        }

        /**
         * readSliceMs is 1s, not something larger, because it is what bounds how
         * long "stop" can take to be noticed: the reader only re-checks the
         * cancel flag when a read returns or times out. Measured with a local
         * server, an 8s slice made stop take 8.0s; 1s makes it about a second,
         * at the cost of one caught timeout per idle second.
         */
        public static StreamPolicy standard() {
            /* 1260s stall = the kernel's longest tool timeout (1200s) plus a
               margin, so no legitimate tool run is ever cut off. 2h total = ten
               agent iterations each allowed a long tool. Stop still lands in
               about a second, because it is checked on every read slice. */
            return new StreamPolicy(15_000, 1_000, 1_260_000, 7_200_000);
        }
    }

    /** One prior turn of conversation. */
    public static final class Msg {
        public final String role;      // "user" or "assistant"
        public final String content;
        public Msg(String role, String content) { this.role = role; this.content = content; }
    }

    /** Legacy entry point: a single timeout, interpreted as the total ceiling. */
    public static void chatStream(String url, String offKey, String prompt, String system,
                                  boolean[] cancelledFlag, ChatListener listener, int timeoutMs) {
        StreamPolicy base = StreamPolicy.standard();
        chatStream(url, offKey, null, prompt, system, cancelledFlag, listener, new StreamPolicy(
                base.connectMs, base.readSliceMs, base.stallMs, Math.max(timeoutMs, base.totalMs)));
    }

    /** Single-prompt form: no conversation before it. */
    public static void chatStream(String url, String offKey, String prompt, String system,
                                  boolean[] cancelledFlag, ChatListener listener, StreamPolicy p) {
        chatStream(url, offKey, null, prompt, system, cancelledFlag, listener, p);
    }

    /**
     * Stream a turn WITH the conversation before it.
     *
     * The engine takes a full Ollama messages array and keeps the last 24
     * entries, so it is built for multi-turn chat. Sending only the newest
     * prompt -- which is what this client used to do -- makes every message a
     * cold start: ask "summarise that" and the model correctly answers that
     * there is nothing before it. Observed live during the engine audit.
     *
     * `history` is oldest-first and may be null. Empty entries are skipped, so
     * a stopped or failed turn cannot poison the context.
     */
    public static void chatStream(String url, String offKey, List<Msg> history, String prompt,
                                  String system, boolean[] cancelledFlag, ChatListener listener,
                                  StreamPolicy p) {
        HttpURLConnection c = null;
        final boolean[] fired = new boolean[] {false};
        try {
            JSONObject body = new JSONObject();
            body.put("stream", true);
            JSONArray msgs = new JSONArray();
            /* No "role":"system" wrapper object -- the engine's contract does not
               use one. System text rides as a leading user message. */
            if (system != null && !system.isEmpty()) {
                msgs.put(new JSONObject().put("role", "user").put("content", system));
            }
            if (history != null) {
                for (Msg m : history) {
                    if (m == null || m.content == null || m.content.isEmpty()) continue;
                    String role = "assistant".equals(m.role) ? "assistant" : "user";
                    msgs.put(new JSONObject().put("role", role).put("content", m.content));
                }
            }
            msgs.put(new JSONObject().put("role", "user").put("content", prompt));
            body.put("messages", msgs);

            c = open("POST", join(url, "/api/chat"), p.connectMs, p.readSliceMs);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Accept", "application/x-ndjson");
            c.setRequestProperty("X-Engine-Key", offKey);
            c.setDoOutput(true);
            byte[] out = body.toString().getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(out.length);
            try (OutputStream os = c.getOutputStream()) { os.write(out); }

            int status = c.getResponseCode();
            if (status != 200) {
                fire(listener, fired, false, describeStatus(status));
                return;
            }

            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                long start = System.currentTimeMillis();
                long lastLine = start;
                while (true) {
                    /* Checked BEFORE the read as well as after. With a stalled
                       socket the old loop could not reach its cancel check for
                       the whole read timeout, so pressing stop appeared to do
                       nothing and the bubble stayed on "generating" for ever. */
                    if (cancelledFlag != null && cancelledFlag[0]) {
                        fire(listener, fired, false, "cancelled");
                        return;
                    }
                    String line;
                    try {
                        line = r.readLine();
                    } catch (java.net.SocketTimeoutException ste) {
                        long now = System.currentTimeMillis();
                        if (now - lastLine > p.stallMs) {
                            fire(listener, fired, false, "engine went quiet for "
                                    + ((now - lastLine) / 1000)
                                    + "s -- the tunnel or the kernel is gone");
                            return;
                        }
                        if (now - start > p.totalMs) {
                            fire(listener, fired, false, "turn ran past "
                                    + (p.totalMs / 1000) + "s and was stopped");
                            return;
                        }
                        continue;      // surface again: cancel, stall, deadline
                    }
                    if (line == null) {
                        /* Server closed the stream: a normal end, not a hang. */
                        fire(listener, fired, true, null);
                        return;
                    }
                    lastLine = System.currentTimeMillis();
                    line = line.trim();
                    if (line.isEmpty()) continue;
                    JSONObject o;
                    try { o = new JSONObject(line); } catch (Exception e) { continue; }

                    /* Payload FIRST. The engine's fallback path re-emits raw
                       Ollama lines, where the final object can carry the last
                       of the content AND done:true together; checking done
                       first silently dropped that content. */
                    JSONObject msg = o.optJSONObject("message");
                    if (msg != null) {
                        String thinking = msg.optString("thinking", "");
                        if (!thinking.isEmpty()) listener.onThinking(thinking);
                        String content = msg.optString("content", "");
                        if (!content.isEmpty()) listener.onContent(content);
                    }
                    if (o.optBoolean("done", false)) {
                        fire(listener, fired, true, null);
                        return;
                    }
                }
            }
        } catch (Exception e) {
            fire(listener, fired, false,
                    e.getMessage() == null ? "stream failed" : e.getMessage());
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Exactly-once terminal callback, so the UI can never be left mid-turn. */
    private static void fire(ChatListener listener, boolean[] fired, boolean ok, String err) {
        if (fired[0]) return;
        fired[0] = true;
        listener.onDone(ok, err);
    }

    /** Say what an HTTP status actually means here instead of just the number. */
    private static String describeStatus(int status) {
        switch (status) {
            case 403: return "engine rejected the key (HTTP 403)";
            case 404: return "engine has no /api/chat (HTTP 404) -- wrong URL?";
            case 502: return "engine unreachable (HTTP 502) -- kernel died or tunnel closed";
            case 503: return "engine unavailable (HTTP 503) -- still booting?";
            case 504: return "engine timed out (HTTP 504)";
            case 530: return "tunnel is gone (HTTP 530) -- the engine is off";
            default:  return "chat HTTP " + status;
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
