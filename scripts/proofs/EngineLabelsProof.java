import com.aether.app.EngineCore;
import com.aether.app.core.EngineLabels;

import java.util.ArrayList;
import java.util.List;

/**
 * The engine rows must describe a measured state in words, never in machine
 * output. These strings are the whole fix for "it shows something like codes",
 * so they are asserted rather than eyeballed.
 *
 * Every state here is built by EngineCore.classify -- the same call the app
 * makes -- so the labels are proven against the real pipeline, including the
 * raw detail text classify puts in EngineState. If classify ever starts writing
 * "/api/ps 200" into a detail, the "no machine output" checks below are what
 * stop it reaching the screen.
 *
 * Run: java -cp /tmp/jvm-suite EngineLabelsProof
 */
public class EngineLabelsProof {
    static int passed = 0, failed = 0;

    static void chk(String what, boolean ok, String seen) {
        System.out.println("  " + (ok ? "ok  " + what : "FAIL " + what) + "   [" + seen + "]");
        if (ok) passed++; else failed++;
    }

    static List<String> models() {
        List<String> m = new ArrayList<>();
        m.add("hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS");
        return m;
    }

    static boolean clean(String s) {
        return !s.contains("HTTP") && !s.contains("/api/") && !s.contains("models=")
                && !s.contains("trycloudflare") && !s.contains("qwen-3-8-27b")
                && !s.contains("instance(s)") && !s.contains("30.00 hours")
                && !s.contains("hf.co/") && !s.contains("IQ4_XS");
    }

    public static void main(String[] a) {
        long now = System.currentTimeMillis();

        EngineCore.EngineState live = EngineCore.classify("b", 200, models(),
                "https://some-tunnel.trycloudflare.com", "running", null);
        EngineCore.EngineState waking = EngineCore.classify("b", 200,
                new ArrayList<String>(), "https://some-tunnel.trycloudflare.com", null, null);
        EngineCore.EngineState off = EngineCore.classify("b", 530, null, null,
                "error", null, now - 60_000);
        EngineCore.EngineState quota = EngineCore.classify("b", -1, null, null, "error",
                EngineCore.Action.quotaHit("wake",
                        "Maximum weekly GPU quota of 30.00 hours reached."));
        EngineCore.EngineState error = EngineCore.classify("b", -1, null, null, null,
                EngineCore.Action.failed("wake", "HTTP 530 tunnel gone"));

        System.out.println("== the pipeline really does produce machine output ==");
        /* Observed, not assumed: classify writes the raw Hugging Face repo path
           into the LIVE detail. That is exactly the "codes" the row must not
           show, which is why the row renders EngineLabels instead. */
        chk("classify's own detail is raw, which is why it must not be shown",
                live.detail.contains("hf.co/"), live.detail);

        System.out.println("\n== one honest sentence per phase ==");
        chk("nothing measured says so, and does not claim OFF",
                EngineLabels.humanLine(null, now).equals("Not checked yet"),
                EngineLabels.humanLine(null, now));
        String l = EngineLabels.humanLine(live, now);
        chk("LIVE reads as ready", l.startsWith("Ready to chat"), l);
        chk("LIVE names the model in readable form", l.contains("Qwen3.8 27B Uncensored"), l);
        chk("LIVE says when it was checked", l.contains("checked just now"), l);
        String w = EngineLabels.humanLine(waking, now);
        chk("WAKING sets the expectation instead of showing a code",
                w.contains("Starting up") && w.contains("few minutes"), w);
        String o = EngineLabels.humanLine(off, now);
        chk("OFF says the GPU is released", o.contains("not holding a GPU"), o);
        chk("OFF carries the age of the measurement", o.contains("checked 1m ago"), o);
        String q = EngineLabels.humanLine(quota, now);
        chk("QUOTA names the real cause", q.contains("limit reached"), q);
        String e = EngineLabels.humanLine(error, now);
        chk("ERROR is a sentence, not a status code", e.contains("Could not be reached"), e);

        System.out.println("\n== no machine output reaches the row ==");
        chk("LIVE line clean", clean(l), l);
        chk("WAKING line clean", clean(w), w);
        chk("OFF line clean", clean(o), o);
        chk("QUOTA line clean", clean(q), q);
        chk("ERROR line clean", clean(e), e);

        System.out.println("\n== model ids are made readable ==");
        chk("repo path, quant tag and GGUF are dropped",
                EngineLabels.shortModel("hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS")
                        .equals("Qwen3.8 27B Uncensored"),
                EngineLabels.shortModel("hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS"));
        chk("a plain name survives", EngineLabels.shortModel("qwen3").equals("qwen3"),
                EngineLabels.shortModel("qwen3"));
        chk("null is empty, not the word null", EngineLabels.shortModel(null).isEmpty(),
                "'" + EngineLabels.shortModel(null) + "'");
        chk("a very long id is truncated with an ellipsis",
                EngineLabels.shortModel("a/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:tag").length() <= 25,
                EngineLabels.shortModel("a/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:tag"));

        System.out.println("\n== the badge is only ever a real phase ==");
        for (EngineCore.Phase p : EngineCore.Phase.values()) {
            chk("badge(" + p + ") is that phase", EngineLabels.badge(p).equals(p.name()),
                    EngineLabels.badge(p));
        }
        chk("badge(null) is UNKNOWN, never LIVE", EngineLabels.badge(null).equals("UNKNOWN"),
                EngineLabels.badge(null));

        System.out.println("\n== ages ==");
        chk("0s is just now", EngineLabels.ago(0).equals("just now"), EngineLabels.ago(0));
        chk("45s is seconds", EngineLabels.ago(45_000).equals("45s ago"), EngineLabels.ago(45_000));
        chk("3m is minutes", EngineLabels.ago(180_000).equals("3m ago"), EngineLabels.ago(180_000));
        chk("2h is hours", EngineLabels.ago(7_200_000).equals("2h ago"), EngineLabels.ago(7_200_000));
        chk("a clock skew cannot produce a negative age",
                EngineLabels.ago(-5_000).equals("just now"), EngineLabels.ago(-5_000));

        System.out.println("\n" + passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }
}
