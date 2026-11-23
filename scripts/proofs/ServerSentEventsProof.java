import com.aether.app.core.ServerSentEvents;

import java.io.IOException;
import java.io.StringReader;
import java.util.ArrayList;
import java.util.List;

/** Framing proof for the incremental SSE reader. No network, no credentials. */
public final class ServerSentEventsProof {
    private static int passed;
    private static int failed;

    private static void check(boolean value, String name) {
        if (value) { passed++; System.out.println("PASS " + name); }
        else { failed++; System.out.println("FAIL " + name); }
    }

    private static List<String> collect(String payload, int maxChars) throws IOException {
        List<String> events = new ArrayList<>();
        ServerSentEvents.read(new StringReader(payload), maxChars,
                (type, data) -> { events.add(type + "|" + data); return true; });
        return events;
    }

    public static void main(String[] args) throws Exception {
        check(collect("data: a\n\ndata: b\n\n", 1024).equals(List.of("message|a", "message|b")),
                "each blank line terminates one event in order");
        check(collect("data: first\ndata: second\n\n", 1024).equals(List.of("message|first\nsecond")),
                "multiple data lines join with a newline");
        check(collect("data:multi\n\n", 1024).equals(List.of("message|multi")),
                "value after the colon without a space is preserved");
        check(collect("data:  padded\n\n", 1024).equals(List.of("message| padded")),
                "only one leading space is stripped");
        check(collect(": heartbeat\ndata: real\n\n", 1024).equals(List.of("message|real")),
                "comment lines are ignored");
        check(collect("event: delta\ndata: x\n\n", 1024).equals(List.of("delta|x")),
                "named events carry their type");
        check(collect("event: delta\ndata: x\n\ndata: y\n\n", 1024).equals(List.of("delta|x", "message|y")),
                "event type does not leak into the next event");
        check(collect("data: [DONE]\n\n", 1024).equals(List.of("message|[DONE]")),
                "terminator is delivered verbatim to the caller");
        check(collect("data: unfinished", 1024).isEmpty(),
                "unterminated trailing event is discarded at EOF");
        check(collect("data: crlf\r\n\r\n", 1024).equals(List.of("message|crlf")),
                "CRLF blank line terminates an event");
        check(collect("data: cr\r\r", 1024).equals(List.of("message|cr")),
                "CR blank line terminates an event");
        check(collect("\uFEFFdata: bom\n\n", 1024).equals(List.of("message|bom")),
                "byte order mark is stripped once");
        check(collect("data: \n\n", 1024).equals(List.of("message|")),
                "empty data value is still an event");

        List<String> stopped = new ArrayList<>();
        ServerSentEvents.read(new StringReader("data: a\n\ndata: b\n\ndata: c\n\n"), 1024,
                (type, data) -> { stopped.add(data); return false; });
        check(stopped.equals(List.of("a")), "returning false stops reading after that event");

        boolean threw = false;
        try { collect("data: " + "x".repeat(64) + "\n\n", 32); }
        catch (IOException expected) { threw = true; }
        check(threw, "oversized stream fails closed instead of buffering");

        boolean rejected = false;
        try { collect("data: a\n\n", 0); }
        catch (IllegalArgumentException expected) { rejected = true; }
        check(rejected, "non-positive limit is rejected");

        check(collect("data: \u00e9\u4e2d\u6587\n\n", 1024).equals(List.of("message|\u00e9\u4e2d\u6587")),
                "non-ASCII content survives framing intact");

        System.out.println(passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }
}
