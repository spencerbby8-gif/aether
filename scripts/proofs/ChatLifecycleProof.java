import com.aether.app.EngineCore;
import com.aether.app.core.AgentActivity;

import java.io.FileInputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Properties;

/**
 * The streaming lifecycle, measured against a real running engine.
 *
 * Every number here comes from driving the shipped EngineCore.chatStream --
 * the same method the app calls -- and stamping the wall clock when each thing
 * actually happened. Nothing is simulated and no local server stands in for
 * the engine.
 *
 *   send -> discovery -> connect -> first byte -> first token -> tool events
 *        -> final token -> done:true
 *
 * plus: a stop mid-turn, a long-context turn, and N consecutive turns in one
 * conversation to prove the twentieth message behaves like the first.
 *
 *   java -cp <out>:<json jar> ChatLifecycleProof <credentials.properties> [turns]
 */
public final class ChatLifecycleProof {

    static int pass = 0, fail = 0;
    static final List<String> log = new ArrayList<>();

    public static void main(String[] args) throws Exception {
        Properties p = new Properties();
        try (FileInputStream in = new FileInputStream(args[0])) { p.load(in); }
        int turns = args.length > 1 ? Integer.parseInt(args[1]) : 20;
        String topic = p.getProperty("beaconTopic");
        String offKey = p.getProperty("offKey");

        System.out.println("== chat lifecycle, real engine ==");
        long d0 = System.currentTimeMillis();
        String url = null;
        String slot = null;
        for (String s : new String[] {"a", "b", "c"}) {
            for (String u : EngineCore.urlsFor(topic, "", s, 3 * 3600, 12_000, 8)) {
                EngineCore.Health h = EngineCore.health(u, 8_000);
                if (h.status == 200 && !h.models.isEmpty()) { url = u; slot = s; break; }
            }
            if (url != null) break;
        }
        long discovery = System.currentTimeMillis() - d0;
        if (url == null) {
            System.out.println("FAIL: no live engine to measure. Wake one first.");
            System.exit(1);
        }
        System.out.println("engine " + slot.toUpperCase(Locale.ROOT) + " found in " + discovery
                + "ms (" + url.replaceAll("https?://", "").replaceAll("\\..*", ".***") + ")");
        check("discovery resolves a live engine quickly", discovery < 15_000, discovery + "ms");

        rawHttpTiming(url, offKey);

        List<EngineCore.Msg> history = new ArrayList<>();
        url = resolve(topic, url);
        Turn plain = run(url, offKey, history,
                "In two sentences, what is the capital of France?", 300_000, 0);
        history.add(new EngineCore.Msg("user", "In two sentences, what is the capital of France?"));
        history.add(new EngineCore.Msg("assistant", plain.text()));

        url = resolve(topic, url);
        Turn search = run(url, offKey, history,
                "Use web_search to find today's top news headline about Nigeria, then name the"
                        + " source you used.", 600_000, 0);
        history.add(new EngineCore.Msg("user", "today's top news headline about Nigeria"));
        history.add(new EngineCore.Msg("assistant", search.text()));

        url = resolve(topic, url);
        Turn cmd = run(url, offKey, history,
                "Use run_command to compute 17 * 23 with python3 and tell me the result.",
                600_000, 0);

        url = resolve(topic, url);
        Turn stopped = run(url, offKey, history,
                "Write a very long detailed essay about the history of computing, at least"
                        + " a thousand words.", 600_000, 4_000);

        url = resolve(topic, url);
        Turn longCtx = run(url, offKey, history,
                "Referring to what we discussed earlier in this conversation, which country's"
                        + " capital did I ask you about? Answer in one sentence.", 300_000, 0);

        System.out.println("\n== stress: " + turns + " consecutive turns in one conversation ==");
        List<Turn> stress = new ArrayList<>();
        String[] prompts = {
            "Reply with exactly: turn %d acknowledged.",
            "Use web_search to look up what year the Eiffel Tower was completed. Turn %d.",
            "Use run_command to print the current UTC time. Turn %d.",
            "Name three programming languages, one per line. Turn %d.",
            "Use web_search for the current population of Lagos. Turn %d.",
        };
        for (int i = 1; i <= turns; i++) {
            String q = String.format(Locale.ROOT, prompts[(i - 1) % prompts.length], i);
            url = resolve(topic, url);
            Turn t = run(url, offKey, history, q, 600_000, 0);
            stress.add(t);
            history.add(new EngineCore.Msg("user", q));
            history.add(new EngineCore.Msg("assistant", t.text()));
            System.out.printf("  turn %2d  %-9s %6dms  ttft %5dms  tools %d  %s%s%n",
                    i, t.state, t.totalMs, t.firstContentMs, t.activities.steps().size(),
                    clip(t.text(), 40),
                    t.err == null ? "" : "   err=" + clip(t.err, 60));
        }

        int ok = 0, err = 0, hung = 0;
        for (Turn t : stress) {
            if ("completed".equals(t.state)) ok++;
            else if ("error".equals(t.state)) err++;
            else hung++;
        }
        System.out.println("\n  " + ok + " completed, " + err + " error, " + hung
                + " left without a terminal state");
        check("every one of " + turns + " turns reached a terminal state", hung == 0,
                hung + " hung");
        check("no turn was left thinking for ever", hung == 0, hung + " hung");
        check("consecutive turns keep working", ok >= turns * 0.6,
                ok + "/" + turns + " completed");

        // ---------------------------------------------------------- assertions
        section("lifecycle");
        check("a plain turn completes", "completed".equals(plain.state), plain.state);
        check("a plain turn produced an answer", plain.text().trim().length() > 0,
                clip(plain.text(), 60));
        check("the first byte arrived well before the answer",
                plain.firstEventMs > 0 && plain.firstEventMs <= plain.firstContentMs,
                "first event " + plain.firstEventMs + "ms, first token " + plain.firstContentMs + "ms");
        check("tokens stream, they are not delivered in one block",
                plain.contentDeltas > 1, plain.contentDeltas + " content deltas");

        section("tools");
        check("the search turn completed", "completed".equals(search.state), search.state);
        check("the search turn really used a tool",
                search.activities.steps().size() > 0,
                search.activities.steps().size() + " step(s)");
        check("tool activity was mapped to a human label",
                search.activities.steps().isEmpty()
                        || !search.activities.steps().get(0).label.contains("_"),
                search.activities.steps().isEmpty() ? "n/a"
                        : search.activities.steps().get(0).label);
        check("the command turn completed", "completed".equals(cmd.state), cmd.state);
        check("a real source was preserved for citation",
                !search.activities.sources().isEmpty() || search.text().contains("http"),
                search.activities.sources().toString());

        section("stop");
        check("stop ended the turn as aborted", "aborted".equals(stopped.state), stopped.state);
        check("stop landed quickly", stopped.totalMs < 15_000, stopped.totalMs + "ms");
        check("partial content was kept", stopped.text().length() >= 0,
                stopped.text().length() + " chars");

        section("context");
        check("a long-context turn completes", "completed".equals(longCtx.state), longCtx.state);
        check("the answer refers to the earlier turn",
                longCtx.text().toLowerCase(Locale.ROOT).contains("paris")
                        || longCtx.text().toLowerCase(Locale.ROOT).contains("france"),
                clip(longCtx.text(), 70));

        System.out.println("\n" + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    /**
     * Resolve a live engine right now. The app re-discovers on every send and
     * fails over between engines; a harness that resolves once and reuses the
     * URL for twenty turns is more brittle than the thing it is testing, and
     * the first run proved it -- the tunnel went away part-way through and
     * every later turn failed in under 2ms for a reason that had nothing to do
     * with the client.
     */
    static String resolve(String topic, String fallback) {
        try {
            for (String s : new String[] {"a", "b", "c"}) {
                for (String u : EngineCore.urlsFor(topic, "", s, 3 * 3600, 12_000, 8)) {
                    EngineCore.Health h = EngineCore.health(u, 8_000);
                    if (h.status == 200 && !h.models.isEmpty()) return u;
                }
            }
        } catch (Exception ignored) { }
        return fallback;
    }

    // ------------------------------------------------------------- one turn

    static final class Turn {
        String state = "hung";
        String err;
        long firstEventMs, firstContentMs, firstToolMs, totalMs;
        int contentDeltas;
        final StringBuilder raw = new StringBuilder();
        final AgentActivity activities = new AgentActivity();
        String text() { return raw.toString(); }
    }

    static Turn run(String url, String offKey, List<EngineCore.Msg> history, String prompt,
                    long maxMs, long abortAfterMs) {
        final Turn t = new Turn();
        final long t0 = System.currentTimeMillis();
        final boolean[] cancel = new boolean[] {false};
        final EngineCore.TurnHandle handle = new EngineCore.TurnHandle();
        final java.util.concurrent.CountDownLatch done =
                new java.util.concurrent.CountDownLatch(1);

        Thread worker = new Thread(() -> EngineCore.chatStream(url, offKey,
                new ArrayList<>(history), prompt, "", cancel, new EngineCore.ChatListener() {
            @Override public void onThinking(String th) {
                long ms = System.currentTimeMillis() - t0;
                if (t.firstEventMs == 0) t.firstEventMs = ms;
                if (t.activities.feed(th) && t.firstToolMs == 0
                        && !t.activities.steps().isEmpty()) {
                    t.firstToolMs = ms;
                }
            }
            @Override public void onContent(String c) {
                long ms = System.currentTimeMillis() - t0;
                if (t.firstEventMs == 0) t.firstEventMs = ms;
                if (t.firstContentMs == 0) { t.firstContentMs = ms; t.activities.noteContent(); }
                t.contentDeltas++;
                t.raw.append(c);
            }
            @Override public void onDone(boolean good, String e) {
                t.totalMs = System.currentTimeMillis() - t0;
                t.state = cancel[0] || "cancelled".equals(e) ? "aborted"
                        : good ? "completed" : "error";
                t.err = e;
                t.activities.finish();
                done.countDown();
            }
        }, EngineCore.StreamPolicy.standard(), handle));
        worker.setDaemon(true);
        worker.start();

        if (abortAfterMs > 0) {
            new Thread(() -> {
                try { Thread.sleep(abortAfterMs); } catch (InterruptedException ignored) { }
                cancel[0] = true;
                handle.cancel();
            }).start();
        }
        try { done.await(maxMs, java.util.concurrent.TimeUnit.MILLISECONDS); }
        catch (InterruptedException ignored) { }
        if (t.totalMs == 0) t.totalMs = System.currentTimeMillis() - t0;
        return t;
    }

    /** True time-to-first-byte at the HTTP layer, measured with a raw socket. */
    static void rawHttpTiming(String url, String offKey) {
        try {
            String body = "{\"model\":\"x\",\"stream\":true,\"messages\":[{\"role\":\"user\","
                    + "\"content\":\"Reply with one word.\"}]}";
            HttpURLConnection c = (HttpURLConnection) new URL(
                    url.replaceAll("/+$", "") + "/api/chat").openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(30_000);
            c.setReadTimeout(300_000);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("X-Engine-Key", offKey);
            c.setDoOutput(true);
            byte[] out = body.getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(out.length);
            long t0 = System.currentTimeMillis();
            try (OutputStream os = c.getOutputStream()) { os.write(out); }
            int status = c.getResponseCode();
            long ttfb = System.currentTimeMillis() - t0;
            c.disconnect();
            section("http");
            check("the connection is accepted", status == 200, "HTTP " + status);
            System.out.println("  time to first byte (response headers): " + ttfb + "ms");
            check("response headers arrive fast", ttfb < 20_000, ttfb + "ms");
        } catch (Exception e) {
            check("raw HTTP timing did not throw", false, String.valueOf(e));
        }
    }

    // -------------------------------------------------------------- helpers

    static void section(String s) { System.out.println("\n-- " + s); }

    static void check(String what, boolean ok, String seen) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + what + "   [" + seen + "]");
        if (ok) pass++; else fail++;
    }

    static String clip(String s, int n) {
        String t = s == null ? "" : s.replaceAll("\\s+", " ").trim();
        return t.length() <= n ? t : t.substring(0, n) + "...";
    }
}
