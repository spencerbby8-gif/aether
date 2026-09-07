import com.sun.net.httpserver.HttpServer;

import com.aether.app.EngineCore;
import com.aether.app.core.ChatMessage;
import com.aether.app.core.MediaItem;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Proves the media path end to end on the JVM, against the real EngineCore
 * parser and the real ChatMessage serialisation -- not a re-implementation.
 *
 * A local HttpServer emits the exact NDJSON the kernel sends, including the
 * structured media event. Then it checks the listener really fires, that media
 * never leaks into the answer text, that garbage media cannot break a turn,
 * and that a generated file survives being written to and read back from
 * storage.
 *
 * Run:
 *   javac -encoding UTF-8 -cp $T/jars/json-20240303.jar -d /tmp/mp \
 *     android/app/src/main/java/com/aether/app/EngineCore.java \
 *     android/app/src/main/java/com/aether/app/core/ChatMessage.java \
 *     android/app/src/main/java/com/aether/app/core/MediaItem.java \
 *     android/app/src/main/java/com/aether/app/core/Attachment.java \
 *     scripts/proofs/MediaStreamProof.java
 *   java -cp /tmp/mp:$T/jars/json-20240303.jar MediaStreamProof
 */
public final class MediaStreamProof {

    private static int pass = 0;
    private static int fail = 0;
    private static HttpServer server;
    private static String base;
    private static final String KEY = "test-key";

    public static void main(String[] args) throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r);
            t.setDaemon(true);
            return t;
        }));

        route("/image", ex -> {
            stream(ex,
                content("Here is your picture."),
                media("image", "https://oaidalleapiprodscus.blob.core.windows.net/a.png",
                      "generate_image"),
                "{\"message\":{\"content\":\"\"},\"done\":true,\"done_reason\":\"stop\"}");
        });

        route("/audio", ex -> {
            stream(ex,
                content("Speaking it now."),
                media("audio", "https://oaidalleapiprodscus.blob.core.windows.net/a.wav",
                      "generate_voice"),
                "{\"message\":{\"content\":\"\"},\"done\":true}");
        });

        route("/both", ex -> {
            stream(ex,
                media("image", "https://example.test/pic.jpg", "generate_image"),
                content("and a voice clip"),
                media("audio", "https://example.test/clip.wav", "generate_voice"),
                "{\"message\":{\"content\":\"\"},\"done\":true}");
        });

        route("/media-without-done", ex -> {
            stream(ex,
                content("partial answer"),
                media("image", "https://example.test/x.png", "generate_image"));
            /* No done line: the server closes. The client must still reach a
               terminal state rather than hang on the media event. */
        });

        route("/no-url", ex -> {
            stream(ex,
                content("fine"),
                "{\"media\":{\"kind\":\"image\",\"url\":\"\",\"source\":\"generate_image\"},"
                    + "\"message\":{\"content\":\"\"},\"done\":false}",
                "{\"message\":{\"content\":\"\"},\"done\":true}");
        });

        route("/rubbish-media", ex -> {
            stream(ex,
                content("still fine"),
                "{\"media\":42,\"message\":{\"content\":\"\"},\"done\":false}",
                "{\"media\":{\"kind\":\"image\"},\"message\":{\"content\":\"\"},\"done\":false}",
                "{\"message\":{\"content\":\"\"},\"done\":true}");
        });

        route("/plain", ex -> {
            stream(ex,
                content("no media at all"),
                "{\"message\":{\"content\":\"\"},\"done\":true}");
        });

        server.start();
        base = "http://127.0.0.1:" + server.getAddress().getPort();

        try {
            imageEventIsReported();
            audioEventIsReported();
            severalMediaKeepTheirOrder();
            mediaNeverLeaksIntoTheAnswer();
            mediaWithoutDoneStillTerminates();
            missingUrlIsIgnored();
            malformedMediaCannotBreakATurn();
            plainTurnIsUnaffected();
            aListenerWithoutOnMediaStillWorks();
            mediaSurvivesSaveAndReload();
            savedNameSurvivesSaveAndReload();
            aMediaRowWithNoUrlIsNeverRestored();
        } finally {
            server.stop(0);
        }

        System.out.println();
        System.out.println("MEDIA PROOF  " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    // ------------------------------------------------------------ scenarios

    private static void imageEventIsReported() {
        section("an image event from the engine");
        Rec r = run("/image", 10_000);
        check("turn finished", r.doneCount.get() == 1, "done=" + r.doneCount.get());
        check("reported ok", r.ok, "error=" + r.error);
        check("exactly one media event", r.media.size() == 1, "n=" + r.media.size());
        check("kind is image", r.media.size() == 1 && "image".equals(r.media.get(0)[0]),
                r.media.isEmpty() ? "none" : r.media.get(0)[0]);
        check("url passed through untouched",
                r.media.size() == 1
                    && "https://oaidalleapiprodscus.blob.core.windows.net/a.png"
                           .equals(r.media.get(0)[1]),
                r.media.isEmpty() ? "none" : r.media.get(0)[1]);
        check("source tool named", r.media.size() == 1 && "generate_image".equals(r.media.get(0)[2]),
                r.media.isEmpty() ? "none" : r.media.get(0)[2]);
        check("answer intact", "Here is your picture.".equals(r.content.toString()),
                "[" + r.content + "]");
    }

    private static void audioEventIsReported() {
        section("a voice clip event");
        Rec r = run("/audio", 10_000);
        check("one media event", r.media.size() == 1, "n=" + r.media.size());
        check("kind is audio", r.media.size() == 1 && "audio".equals(r.media.get(0)[0]),
                r.media.isEmpty() ? "none" : r.media.get(0)[0]);
        check("url ends in .wav",
                r.media.size() == 1 && r.media.get(0)[1].endsWith("a.wav"),
                r.media.isEmpty() ? "none" : r.media.get(0)[1]);
    }

    private static void severalMediaKeepTheirOrder() {
        section("image and voice in one turn");
        Rec r = run("/both", 10_000);
        check("two media events", r.media.size() == 2, "n=" + r.media.size());
        check("image first", r.media.size() == 2 && "image".equals(r.media.get(0)[0]),
                r.media.isEmpty() ? "none" : r.media.get(0)[0]);
        check("audio second", r.media.size() == 2 && "audio".equals(r.media.get(1)[0]),
                r.media.size() < 2 ? "none" : r.media.get(1)[0]);
        check("answer between them survived", "and a voice clip".equals(r.content.toString()),
                "[" + r.content + "]");
    }

    private static void mediaNeverLeaksIntoTheAnswer() {
        section("media must not pollute the conversation");
        Rec r = run("/both", 10_000);
        String text = r.content.toString();
        check("no url in the answer", !text.contains("http"), "[" + text + "]");
        check("no json in the answer", !text.contains("{") && !text.contains("media"),
                "[" + text + "]");
        boolean leaked = false;
        for (String t : r.thinking) if (t.contains("blob.core") || t.contains("example.test")) leaked = true;
        check("no url in the activity strip either", !leaked, r.thinking.toString());
    }

    private static void mediaWithoutDoneStillTerminates() {
        section("media event then the socket closes");
        Rec r = run("/media-without-done", 20_000);
        check("reached a terminal state", r.doneCount.get() == 1,
                "done=" + r.doneCount.get() + " error=" + r.error);
        check("media still delivered", r.media.size() == 1, "n=" + r.media.size());
        check("partial answer kept", "partial answer".equals(r.content.toString()),
                "[" + r.content + "]");
    }

    private static void missingUrlIsIgnored() {
        section("a media event with an empty url");
        Rec r = run("/no-url", 10_000);
        check("turn finished", r.doneCount.get() == 1, "done=" + r.doneCount.get());
        check("no media reported", r.media.isEmpty(), "n=" + r.media.size());
        check("answer intact", "fine".equals(r.content.toString()), "[" + r.content + "]");
    }

    private static void malformedMediaCannotBreakATurn() {
        section("media as a number, and media with no url key");
        Rec r = run("/rubbish-media", 10_000);
        check("turn finished cleanly", r.doneCount.get() == 1 && r.ok,
                "done=" + r.doneCount.get() + " error=" + r.error);
        check("no media reported", r.media.isEmpty(), "n=" + r.media.size());
        check("answer intact", "still fine".equals(r.content.toString()), "[" + r.content + "]");
    }

    private static void plainTurnIsUnaffected() {
        section("an ordinary turn with no media");
        Rec r = run("/plain", 10_000);
        check("finished", r.doneCount.get() == 1 && r.ok, "error=" + r.error);
        check("no media reported", r.media.isEmpty(), "n=" + r.media.size());
        check("answer intact", "no media at all".equals(r.content.toString()), "[" + r.content + "]");
    }

    /**
     * The interface method is default, so a listener written before media
     * existed still compiles and still receives everything else. Seven proof
     * harnesses depend on that.
     */
    private static void aListenerWithoutOnMediaStillWorks() {
        section("a listener that never heard of media");
        final StringBuilder content = new StringBuilder();
        final CountDownLatch latch = new CountDownLatch(1);
        final boolean[] ok = { false };
        Thread t = new Thread(() -> EngineCore.chatStream(base + "/image", KEY, "hi", "",
                null, new EngineCore.ChatListener() {
                    @Override public void onThinking(String text) { }
                    @Override public void onContent(String text) { content.append(text); }
                    @Override public void onDone(boolean good, String err) {
                        ok[0] = good;
                        latch.countDown();
                    }
                }, EngineCore.StreamPolicy.standard()));
        t.setDaemon(true);
        t.start();
        boolean done = false;
        try { done = latch.await(10_000, TimeUnit.MILLISECONDS); } catch (InterruptedException e) { }
        check("old-style listener still completes", done && ok[0], "done=" + done);
        check("old-style listener still gets the answer",
                "Here is your picture.".equals(content.toString()), "[" + content + "]");
    }

    private static void mediaSurvivesSaveAndReload() {
        section("persistence: write the transcript, read it back");
        try {
            ChatMessage m = new ChatMessage(ChatMessage.ROLE_ASSISTANT);
            m.content = "Here it is.";
            m.media = new ArrayList<>();
            m.media.add(new MediaItem("image", "https://example.test/pic.jpg", "generate_image"));
            m.media.add(new MediaItem("audio", "https://example.test/clip.wav", "generate_voice"));

            ChatMessage back = ChatMessage.fromJson(m.toJson());
            check("two items restored", back.media != null && back.media.size() == 2,
                    "n=" + (back.media == null ? -1 : back.media.size()));
            check("image kind kept", back.media.size() == 2 && back.media.get(0).isImage(),
                    back.media.get(0).kind);
            check("audio kind kept", back.media.size() == 2 && back.media.get(1).isAudio(),
                    back.media.get(1).kind);
            check("url kept", "https://example.test/pic.jpg".equals(back.media.get(0).url),
                    back.media.get(0).url);
            check("source kept", "generate_voice".equals(back.media.get(1).source),
                    back.media.get(1).source);
            check("answer kept", "Here it is.".equals(back.content), "[" + back.content + "]");
        } catch (Exception e) {
            check("persistence round trip", false, String.valueOf(e));
        }
    }

    private static void savedNameSurvivesSaveAndReload() {
        section("persistence: the record of a completed download");
        try {
            ChatMessage m = new ChatMessage(ChatMessage.ROLE_ASSISTANT);
            m.content = "saved one";
            MediaItem it = new MediaItem("image", "https://example.test/pic.jpg", "generate_image");
            it.savedName = "pic.jpg";
            m.media = new ArrayList<>();
            m.media.add(it);

            ChatMessage back = ChatMessage.fromJson(m.toJson());
            check("saved name kept", back.media.size() == 1 && "pic.jpg".equals(back.media.get(0).savedName),
                    back.media.isEmpty() ? "none" : String.valueOf(back.media.get(0).savedName));
            check("button will show Saved, not re-download",
                    back.media.size() == 1 && back.media.get(0).savedName != null, "n/a");
        } catch (Exception e) {
            check("saved-name round trip", false, String.valueOf(e));
        }
    }

    private static void aMediaRowWithNoUrlIsNeverRestored() {
        section("restoring a corrupt media row");
        try {
            JSONObject o = new JSONObject();
            o.put("role", ChatMessage.ROLE_ASSISTANT);
            o.put("content", "x");
            JSONArray arr = new JSONArray();
            arr.put(new JSONObject().put("kind", "image").put("url", "not-a-url"));
            arr.put(new JSONObject().put("kind", "audio"));
            arr.put(new JSONObject().put("kind", "image").put("url", "https://example.test/ok.png"));
            o.put("media", arr);
            ChatMessage back = ChatMessage.fromJson(o);
            check("unusable rows dropped, good one kept",
                    back.media.size() == 1 && "https://example.test/ok.png".equals(back.media.get(0).url),
                    "n=" + back.media.size());
        } catch (Exception e) {
            check("corrupt media row", false, String.valueOf(e));
        }
    }

    // ------------------------------------------------------------- plumbing

    private static void route(String path, com.sun.net.httpserver.HttpHandler h) {
        server.createContext(path, h);
    }

    private static void stream(com.sun.net.httpserver.HttpExchange ex, String... lines)
            throws java.io.IOException {
        ex.getResponseHeaders().add("Content-Type", "application/x-ndjson");
        ex.sendResponseHeaders(200, 0);
        OutputStream o = ex.getResponseBody();
        for (String l : lines) write(o, l);
        o.close();
    }

    private static String content(String text) {
        return "{\"message\":{\"content\":\"" + text + "\"},\"done\":false}";
    }

    private static String media(String kind, String url, String source) {
        return "{\"media\":{\"kind\":\"" + kind + "\",\"url\":\"" + url
                + "\",\"source\":\"" + source + "\"},\"message\":{\"content\":\"\"},\"done\":false}";
    }

    private static void write(OutputStream o, String line) throws java.io.IOException {
        o.write((line + "\n").getBytes("UTF-8"));
        o.flush();
    }

    private static final class Rec {
        final StringBuilder content = new StringBuilder();
        final List<String> thinking = new ArrayList<>();
        /** kind, url, source per media event, in arrival order. */
        final List<String[]> media = new ArrayList<>();
        final AtomicInteger doneCount = new AtomicInteger();
        volatile boolean ok;
        volatile String error;
    }

    private static Rec run(String path, long waitMs) {
        final Rec rec = new Rec();
        final CountDownLatch latch = new CountDownLatch(1);
        Thread t = new Thread(() -> EngineCore.chatStream(base + path, KEY, "hi", "",
                null, new EngineCore.ChatListener() {
                    @Override public void onThinking(String text) { rec.thinking.add(text); }
                    @Override public void onContent(String text) { rec.content.append(text); }
                    @Override public void onMedia(String kind, String url, String source) {
                        rec.media.add(new String[] { kind, url, source });
                    }
                    @Override public void onDone(boolean ok, String err) {
                        rec.ok = ok;
                        rec.error = err;
                        rec.doneCount.incrementAndGet();
                        latch.countDown();
                    }
                }, EngineCore.StreamPolicy.standard()));
        t.setDaemon(true);
        t.start();
        try {
            if (!latch.await(waitMs, TimeUnit.MILLISECONDS)) {
                rec.error = "NO TERMINAL CALLBACK within " + waitMs + "ms";
                rec.doneCount.set(0);
            }
        } catch (InterruptedException ignored) { }
        return rec;
    }

    private static void section(String name) {
        System.out.println();
        System.out.println("== " + name);
    }

    private static void check(String name, boolean ok, String detail) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + name
                + (ok ? "" : "   [" + detail + "]"));
        if (ok) pass++; else fail++;
    }
}
