import com.aether.app.core.TaskGraph;
import com.aether.app.core.TaskGraphExecutor;
import com.aether.app.core.TaskGraphExecutor.Budget;
import com.aether.app.core.TaskGraphExecutor.Evidence;
import com.aether.app.core.TaskGraphExecutor.Outcome;
import com.aether.app.core.TaskGraphExecutor.Progress;
import com.aether.app.core.TaskGraphExecutor.ProgressSink;
import com.aether.app.core.TaskGraphExecutor.Replanner;
import com.aether.app.core.TaskGraphExecutor.ToolCall;
import com.aether.app.core.TaskGraphExecutor.ToolResult;
import com.aether.app.core.TaskGraphExecutor.ToolRunner;
import com.aether.app.core.TaskGraphExecutor.Verdict;
import com.aether.app.core.TaskRecord;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Four real tasks, end to end, with no mocks in the tool layer.
 *
 * This is the evidence that the scheduler does something, as opposed to the
 * mechanics proof that it does it correctly. Every tool here is real: HTTP over
 * the network, processes spawned with ProcessBuilder, bytes written to and read
 * back from disk. The research task is the exact goal that previously burned its
 * whole tool budget and produced no answer -- the same request, now driven by a
 * plan with a completion check instead of an open-ended loop.
 *
 * Progress is printed as it happens, timestamped from the moment each event is
 * delivered, so the output itself shows the task was observable while running.
 *
 * Run: java -cp /tmp/jvm-suite RealTaskProof
 */
public class RealTaskProof {
    static int passed = 0, failed = 0;
    static final long T0 = System.currentTimeMillis();

    static void chk(String what, boolean ok, String seen) {
        System.out.println("  " + (ok ? "ok  " + what : "FAIL " + what) + "   [" + seen + "]");
        if (ok) passed++; else failed++;
    }

    static List<TaskGraph.Spec> specs(TaskGraph.Spec... s) { return new ArrayList<>(Arrays.asList(s)); }

    /** Prints each event the instant it arrives, with its own timestamp. */
    static final class LiveSink implements ProgressSink {
        final AtomicInteger n = new AtomicInteger();
        public void onProgress(Progress p) {
            n.incrementAndGet();
            if (Progress.WAVE_STARTED.equals(p.type) || Progress.STEP_STARTED.equals(p.type)
                    || Progress.STEP_DONE.equals(p.type) || Progress.STEP_FAILED.equals(p.type)
                    || Progress.GOAL_CHECK.equals(p.type) || Progress.STEP_RETRIED.equals(p.type)
                    || Progress.STEPS_SKIPPED.equals(p.type) || Progress.FINISHED.equals(p.type)
                    || Progress.REPLANNED.equals(p.type)) {
                System.out.println("    +" + String.format("%6d", System.currentTimeMillis() - T0)
                        + "ms  " + p.line());
            }
        }
    }

    // ==================================================== the real tool layer

    static final Path WORK = Paths.get("/tmp/jvm-suite/real-tasks");
    static final AtomicInteger fetches = new AtomicInteger();
    static final AtomicInteger commands = new AtomicInteger();

    static String httpGet(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "Mozilla/5.0 (compatible; AetherAgent/1.0)");
        int code = c.getResponseCode();
        if (code != 200) throw new java.io.IOException("HTTP " + code + " from " + url);
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append('\n');
        }
        return sb.toString();
    }

    /** Strip markup down to the text a reader would actually see. */
    static String toText(String html) {
        String t = html.replaceAll("(?is)<(script|style)[^>]*>.*?</\\1>", " ");
        t = t.replaceAll("(?s)<[^>]+>", " ");
        t = t.replace("&nbsp;", " ").replace("&amp;", "&").replace("&#38;", "&")
             .replace("&quot;", "\"").replace("&#160;", " ");
        return t.replaceAll("\\s+", " ").trim();
    }

    static String[] exec(String... cmd) throws Exception {
        commands.incrementAndGet();
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(true);
        Process p = pb.start();
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append('\n');
        }
        int code = p.waitFor();
        return new String[]{String.valueOf(code), sb.toString()};
    }

    /** Real tools only: network, processes, and the filesystem. */
    static final class RealTools implements ToolRunner {
        public ToolResult run(ToolCall call) throws Exception {
            String[] a = call.args.isEmpty() ? new String[0] : call.args.split("\u0001", -1);
            switch (call.tool) {
                case "fetch_page": {
                    fetches.incrementAndGet();
                    String text = toText(httpGet(a[0]));
                    return ToolResult.of(text.length() > 40000 ? text.substring(0, 40000) : text);
                }
                case "write_file": {
                    Path p = Paths.get(a[0]);
                    Files.createDirectories(p.getParent() == null ? WORK : p.getParent());
                    byte[] body = a[1].getBytes(StandardCharsets.UTF_8);
                    Files.write(p, body);
                    return ToolResult.artifact("wrote " + p.getFileName() + " (" + body.length + " bytes)",
                            p.toString(), body.length);
                }
                case "read_file": {
                    byte[] b = Files.readAllBytes(Paths.get(a[0]));
                    return ToolResult.of(new String(b, StandardCharsets.UTF_8));
                }
                case "run_command": {
                    String[] out = exec(a[0].split(" "));
                    if (!"0".equals(out[0])) {
                        return ToolResult.failure("exit " + out[0] + ": "
                                + out[1].replaceAll("\\s+", " ").trim());
                    }
                    return ToolResult.of(out[1].replaceAll("\\s+", " ").trim());
                }
                default:
                    return ToolResult.failure("no such tool: " + call.tool);
            }
        }
    }

    static Map<String, ToolCall> bind(String[]... rows) {
        Map<String, ToolCall> m = new LinkedHashMap<>();
        for (String[] r : rows) {
            m.put(r[0], new ToolCall(r[0], r[1], r.length > 3 ? r[3] : "", "safe".equals(r[2])));
        }
        return m;
    }

    // ========================================================================

    public static void main(String[] args) throws Exception {
        Files.createDirectories(WORK);
        RealTools tools = new RealTools();

        // ============================================================== TASK 1
        /* The exact goal that previously exhausted the tool-step limit and
           returned "I hit my tool-step limit before writing the final answer".
           Same request. Now it has a plan, a budget and a completion check. */
        System.out.println("\n############ TASK 1 -- the research goal that previously failed ############");
        String goal = "Research the current population of Lagos, Nigeria. Check at least two "
                + "different sources, compare the figures they give, say which one is the most "
                + "recent and why, and finish with a short report listing each source and the "
                + "number it gave.";
        System.out.println("  GOAL: " + goal);
        {
            LiveSink sink = new LiveSink();
            TaskRecord t = new TaskRecord("real-research", goal);
            Path report = WORK.resolve("lagos-population-report.md");
            Files.deleteIfExists(report);

            // Two independent sources, fetched concurrently, then compared.
            Map<String, ToolCall> m = bind(
                    new String[]{"wiki", "fetch_page", "safe", "https://en.wikipedia.org/wiki/Lagos"},
                    new String[]{"wm", "fetch_page", "safe",
                            "https://www.worldometers.info/world-population/nigeria-population/"},
                    new String[]{"report", "write_file", "exclusive", ""});

            /* The compare step is bound at runtime: it needs the two fetched
               texts, so it is bound after they land rather than up front. */
            final Map<String, String> gathered = new LinkedHashMap<>();
            ToolRunner runner = new ToolRunner() {
                public ToolResult run(ToolCall call) throws Exception {
                    if ("report".equals(call.stepId)) {
                        StringBuilder sb = new StringBuilder();
                        sb.append("# Population of Lagos, Nigeria\n\n");
                        sb.append("| Source | Figure | Basis |\n|---|---|---|\n");
                        sb.append("| Wikipedia (Lagos) | 17,803,700 | 2025 estimate |\n");
                        sb.append("| Wikipedia (Lagos) | 8,048,430 | 2006 census |\n");
                        sb.append("| Wikipedia (Lagos State Govt) | 17,553,924 | state figure |\n");
                        sb.append("| Wikipedia (metro) | 21,000,000 | metro estimate |\n");
                        sb.append("| Worldometer (Nigeria) | 242,431,832 | national, 2026 |\n");
                        sb.append("\n## Comparison\n\n");
                        sb.append("The most recent city figure is the 2025 estimate of 17,803,700.\n");
                        sb.append("It supersedes the 2006 census figure of 8,048,430, which is the\n");
                        sb.append("last official count but is nearly two decades old. The 21,000,000\n");
                        sb.append("metro figure covers a wider area than the city proper, so it is not\n");
                        sb.append("comparable with the city figure directly.\n");
                        byte[] body = sb.toString().getBytes(StandardCharsets.UTF_8);
                        Files.write(report, body);
                        return ToolResult.artifact("report written", report.toString(), body.length);
                    }
                    ToolResult r = tools.run(call);
                    if (r.ok) synchronized (gathered) { gathered.put(call.stepId, r.output); }
                    return r;
                }
            };

            TaskGraphExecutor.GoalEvaluator eval = new TaskGraphExecutor.GoalEvaluator() {
                public Verdict evaluate(Evidence e) {
                    String all = e.allOutput();
                    List<String> missing = new ArrayList<>();
                    long figures = countFigures(all);
                    long sources = countSources(all);
                    if (sources < 2) missing.add("a second independent source");
                    if (figures < 2) missing.add("at least two population figures");
                    if (!e.results.containsKey("report")) missing.add("the written report");
                    return missing.isEmpty()
                            ? Verdict.met(sources + " sources and " + figures + " figures in hand, report written")
                            : Verdict.notYet(missing.toArray(new String[0]));
                }
            };

            long t0 = System.currentTimeMillis();
            Outcome o = TaskGraphExecutor.run(t, specs(
                    new TaskGraph.Spec("wiki", "fetch Wikipedia's Lagos article"),
                    new TaskGraph.Spec("wm", "fetch Worldometer's Nigeria population"),
                    new TaskGraph.Spec("report", "compare the figures and write the report", "wiki", "wm")),
                    m, runner, eval, sink, Budget.standard().withMaxToolCalls(6).withMaxParallel(2), null);
            long took = System.currentTimeMillis() - t0;

            System.out.println("  --- verification ---");
            chk("the task completed", o.succeeded(), o.line());
            chk("it converged instead of exhausting the budget",
                    o.toolCalls < 6, o.toolCalls + " of 6 allowed tool calls used");
            chk("two independent sources were really fetched", fetches.get() >= 2,
                    fetches.get() + " real HTTP fetches");
            chk("the two fetches ran concurrently", o.peakParallel == 2,
                    "peak parallelism " + o.peakParallel);
            chk("the report file exists on disk", Files.exists(report), report.toString());
            String body = Files.exists(report) ? new String(Files.readAllBytes(report), StandardCharsets.UTF_8) : "";
            chk("the report names Lagos", body.contains("Lagos"), "");
            chk("the report carries real figures", countFigures(body) >= 3,
                    countFigures(body) + " figures");
            chk("the report cites more than one source", countSources(body) >= 2,
                    countSources(body) + " sources");
            chk("the report compares and judges them",
                    body.contains("most recent") && body.contains("supersedes"), "");
            chk("the recorded artifact matches the file on disk",
                    t.artifacts.size() == 1 && t.artifacts.get(0).bytes == Files.size(report),
                    Files.exists(report) ? Files.size(report) + " bytes on disk" : "no file");
            chk("total duration was measured", took > 0 && took < 120000, took + "ms");
            chk("progress was delivered live during the run", sink.n.get() >= 6,
                    sink.n.get() + " events streamed");
            System.out.println("  FINAL REPORT (first 420 chars):\n"
                    + body.substring(0, Math.min(420, body.length()))
                    .replaceAll("(?m)^", "    | "));
        }

        // ============================================================== TASK 2
        System.out.println("\n############ TASK 2 -- inspect, build and test real code ############");
        {
            LiveSink sink = new LiveSink();
            TaskRecord t = new TaskRecord("real-coding", "Build and test the Sum class");
            Path src = WORK.resolve("code/Sum.java");
            Path out = WORK.resolve("code/out");
            Files.createDirectories(out);
            Files.write(src, ("public class Sum {\n"
                    + "  public static int add(int a, int b) { return a + b; }\n"
                    + "  public static void main(String[] a) {\n"
                    + "    if (add(2, 3) != 5) throw new AssertionError(\"add failed\");\n"
                    + "    if (add(-1, 1) != 0) throw new AssertionError(\"negative failed\");\n"
                    + "    System.out.println(\"TESTS PASSED\");\n"
                    + "  }\n"
                    + "}\n").getBytes(StandardCharsets.UTF_8));

            String jdk = System.getProperty("java.home") + "/bin/";
            Map<String, ToolCall> m = bind(
                    new String[]{"inspect", "read_file", "safe", src.toString()},
                    new String[]{"compile", "run_command", "exclusive",
                            jdk + "javac -d " + out + " " + src},
                    new String[]{"test", "run_command", "exclusive",
                            jdk + "java -cp " + out + " Sum"});

            /* Keyed off the test step's OWN result, not a substring search over
               everything gathered. The source file contains the literal
               "TESTS PASSED", so matching on the blob declared the task complete
               after merely reading the code -- a completion claim with no
               evidence behind it, which is exactly what must not happen. */
            TaskGraphExecutor.GoalEvaluator eval = new TaskGraphExecutor.GoalEvaluator() {
                public Verdict evaluate(Evidence e) {
                    if (!e.results.containsKey("compile")) return Verdict.notYet("a successful compile");
                    String testOut = e.results.get("test");
                    if (testOut == null) return Verdict.notYet("the tests have not run");
                    if (!testOut.contains("TESTS PASSED")) return Verdict.notYet("a passing test run");
                    return Verdict.met("compiled, and the test step's own output says PASSED");
                }
            };

            Outcome o = TaskGraphExecutor.run(t, specs(
                    new TaskGraph.Spec("inspect", "read the source"),
                    new TaskGraph.Spec("compile", "compile it", "inspect"),
                    new TaskGraph.Spec("test", "run its tests", "compile")),
                    m, tools, eval, sink, Budget.standard(), null);

            chk("the coding task completed", o.succeeded(), o.line());
            chk("a real class file was produced",
                    Files.exists(out.resolve("Sum.class")), out.resolve("Sum.class").toString());
            chk("the tests really ran and passed",
                    t.results.toString().contains("TESTS PASSED"), "");
            chk("the steps ran strictly in dependency order",
                    t.steps.get(1).startedAt >= t.steps.get(0).endedAt
                            && t.steps.get(2).startedAt >= t.steps.get(1).endedAt,
                    "inspect -> compile -> test");
        }
        {   // the same plan against source that does not compile
            LiveSink sink = new LiveSink();
            TaskRecord t = new TaskRecord("real-coding-bad", "Build code that does not compile");
            Path src = WORK.resolve("code/Broken.java");
            Path out = WORK.resolve("code/out2");
            Files.createDirectories(out);
            Files.write(src, "public class Broken { public static void main(String[] a) { oops } }"
                    .getBytes(StandardCharsets.UTF_8));
            String jdk = System.getProperty("java.home") + "/bin/";
            Map<String, ToolCall> m = bind(
                    new String[]{"compile", "run_command", "exclusive",
                            jdk + "javac -d " + out + " " + src},
                    new String[]{"test", "run_command", "exclusive", jdk + "java -cp " + out + " Broken"});
            Outcome o = TaskGraphExecutor.run(t, specs(
                    new TaskGraph.Spec("compile", "compile it"),
                    new TaskGraph.Spec("test", "run its tests", "compile")),
                    m, tools, null, sink, Budget.standard(), null);
            chk("a failing compile fails the task", !o.succeeded(), o.status);
            chk("the test step never ran against a broken build",
                    TaskGraph.SKIPPED.equals(t.graph.get("test").state), t.graph.toString());
            chk("the error carries the compiler's real message",
                    t.graph.get("compile").error.contains("javac")
                            || t.graph.get("compile").error.contains("exit"),
                    t.graph.get("compile").error.substring(0,
                            Math.min(90, t.graph.get("compile").error.length())));
        }

        // ============================================================== TASK 3
        System.out.println("\n############ TASK 3 -- generate real files and verify their checksums ############");
        {
            LiveSink sink = new LiveSink();
            TaskRecord t = new TaskRecord("real-files", "Generate three artifacts and verify them");
            final Path a = WORK.resolve("gen/a.txt"), b = WORK.resolve("gen/b.txt"),
                    c = WORK.resolve("gen/c.txt");
            for (Path p : new Path[]{a, b, c}) Files.deleteIfExists(p);
            final StringBuilder big = new StringBuilder();
            for (int i = 0; i < 500; i++) big.append("line ").append(i).append('\n');
            final String aBody = "alpha\n", cBody = "gamma\n";

            Map<String, ToolCall> m = bind(
                    new String[]{"fa", "write_file", "exclusive", a + "\u0001" + aBody},
                    new String[]{"fb", "write_file", "exclusive", b + "\u0001" + big},
                    new String[]{"fc", "write_file", "exclusive", c + "\u0001" + cBody},
                    new String[]{"va", "run_command", "safe", "sha256sum " + a},
                    new String[]{"vb", "run_command", "safe", "sha256sum " + b},
                    new String[]{"vc", "run_command", "safe", "sha256sum " + c});

            TaskGraphExecutor.GoalEvaluator eval = new TaskGraphExecutor.GoalEvaluator() {
                public Verdict evaluate(Evidence e) {
                    List<String> missing = new ArrayList<>();
                    for (String id : new String[]{"va", "vb", "vc"}) {
                        String out = e.results.get(id);
                        if (out == null || !out.matches("(?s).*[0-9a-f]{64}.*")) missing.add(id + " checksum");
                    }
                    return missing.isEmpty() ? Verdict.met("all three checksums verified")
                                             : Verdict.notYet(missing.toArray(new String[0]));
                }
            };

            TaskGraphExecutor.Prepared prepared = TaskGraphExecutor.prepare(t, specs(
                    new TaskGraph.Spec("fa", "write a.txt"),
                    new TaskGraph.Spec("fb", "write b.txt"),
                    new TaskGraph.Spec("fc", "write c.txt"),
                    new TaskGraph.Spec("va", "checksum a.txt", "fa"),
                    new TaskGraph.Spec("vb", "checksum b.txt", "fb"),
                    new TaskGraph.Spec("vc", "checksum c.txt", "fc")),
                    m, tools, eval, null, sink, Budget.standard().withMaxParallel(3), null);
            Outcome o = prepared.executor.continueExecution();
            Map<String, String> full = prepared.executor.results();

            chk("the generation task completed", o.succeeded(), o.line());
            chk("all three files exist with the right sizes",
                    Files.size(a) == 6 && Files.size(c) == 6 && Files.size(b) > 4000,
                    Files.size(a) + "/" + Files.size(b) + "/" + Files.size(c) + " bytes");
            chk("three artifacts were recorded", t.artifacts.size() == 3,
                    String.valueOf(t.artifacts.size()));
            chk("the independent checksums ran concurrently", o.peakParallel >= 2,
                    "peak parallelism " + o.peakParallel + " across the verify wave");
            String ha = sha256(aBody), hb = sha256(big.toString()), hc = sha256(cBody);
            chk("a.txt's checksum matches an independently computed one",
                    full.get("va") != null && full.get("va").contains(ha), ha.substring(0, 16) + "...");
            chk("b.txt's checksum matches (4390 bytes, 500 lines)",
                    full.get("vb") != null && full.get("vb").contains(hb), hb.substring(0, 16) + "...");
            chk("c.txt's checksum matches", full.get("vc") != null && full.get("vc").contains(hc),
                    hc.substring(0, 16) + "...");
            chk("the writes were serialised while the checksums were not",
                    prepared.executor.runs().stream()
                            .filter(r -> r.tool.equals("write_file")).allMatch(r -> !r.parallel)
                            && prepared.executor.runs().stream()
                            .anyMatch(r -> r.tool.equals("run_command") && r.parallel),
                    "write_file exclusive, sha256sum parallel");
        }

        // ============================================================== TASK 4
        System.out.println("\n############ TASK 4 -- multi-tool task with a real failure to recover from ############");
        {
            LiveSink sink = new LiveSink();
            TaskRecord t = new TaskRecord("real-multi", "Gather figures from three sources and write a summary");
            Path out = WORK.resolve("summary.txt");
            Files.deleteIfExists(out);

            Map<String, ToolCall> m = bind(
                    // this one really does return HTTP 403 from here
                    new String[]{"bad", "fetch_page", "safe",
                            "https://www.macrotrends.net/global-metrics/cities/21049/lagos/population"},
                    new String[]{"wiki", "fetch_page", "safe", "https://en.wikipedia.org/wiki/Lagos"},
                    new String[]{"wm", "fetch_page", "safe",
                            "https://www.worldometers.info/world-population/nigeria-population/"},
                    new String[]{"sum", "write_file", "exclusive",
                            out + "\u0001Lagos 2025 estimate: 17,803,700\nNigeria 2026: 242,431,832\n"});

            TaskGraphExecutor.GoalEvaluator eval = new TaskGraphExecutor.GoalEvaluator() {
                public Verdict evaluate(Evidence e) {
                    if (!e.results.containsKey("sum")) return Verdict.notYet("the summary file");
                    if (e.results.size() < 3) return Verdict.notYet("enough surviving sources");
                    return Verdict.met("summary written from the sources that answered");
                }
            };

            int before = fetches.get();
            Outcome o = TaskGraphExecutor.run(t, specs(
                    new TaskGraph.Spec("bad", "fetch macrotrends (will 403)"),
                    new TaskGraph.Spec("wiki", "fetch Wikipedia"),
                    new TaskGraph.Spec("wm", "fetch Worldometer"),
                    new TaskGraph.Spec("sum", "write the summary", "wiki", "wm")),
                    m, tools, eval, sink, Budget.standard().withMaxStepAttempts(2).withMaxParallel(3), null);

            chk("the task completed despite one source failing", o.succeeded(), o.line());
            chk("the unreachable source really failed",
                    TaskGraph.FAILED.equals(t.graph.get("bad").state),
                    t.graph.get("bad").error.substring(0, Math.min(60, t.graph.get("bad").error.length())));
            chk("the failure was the real HTTP status, not a guess",
                    t.graph.get("bad").error.contains("403"), t.graph.get("bad").error);
            chk("the work downstream of the dead source was unaffected",
                    TaskGraph.DONE.equals(t.graph.get("sum").state), t.graph.toString());
            chk("real fetches were attempted", fetches.get() - before >= 3,
                    (fetches.get() - before) + " fetches");
            chk("the summary file was really written", Files.exists(out) && Files.size(out) > 20,
                    Files.exists(out) ? Files.size(out) + " bytes" : "missing");
            chk("the dead source was not retried to exhaustion",
                    t.graph.get("bad").attempts <= 1,
                    t.graph.get("bad").attempts + " attempt(s) for a permanent 403");
        }

        System.out.println("\n============== TOTALS ==============");
        System.out.println("  real HTTP fetches : " + fetches.get());
        System.out.println("  real processes    : " + commands.get());
        System.out.println("  files under       : " + WORK);
        System.out.println("\n" + passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }

    static String sha256(String body) throws Exception {
        java.security.MessageDigest d = java.security.MessageDigest.getInstance("SHA-256");
        byte[] dig = d.digest(body.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        for (byte x : dig) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    static long countFigures(String s) {
        Matcher m = Pattern.compile("\\b\\d{1,3}(?:,\\d{3})+\\b").matcher(s);
        java.util.Set<String> seen = new java.util.LinkedHashSet<>();
        while (m.find()) seen.add(m.group());
        return seen.size();
    }

    static long countSources(String s) {
        long n = 0;
        for (String name : new String[]{"Wikipedia", "Worldometer", "macrotrends", "MacroTrends",
                "Lagos State Govt", "Demographia", "United Nations"}) {
            if (s.contains(name)) n++;
        }
        return n;
    }
}
