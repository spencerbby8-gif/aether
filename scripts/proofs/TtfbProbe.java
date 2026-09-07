import com.aether.app.EngineCore;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * Measures what the phone has to survive: how long the engine takes to send the
 * FIRST BYTE of a chat reply, and the longest silent gap inside the stream.
 *
 * The app sets a socket read timeout of readSliceMs on the same connection it
 * streams from. On the JDK a read timeout is recoverable (the loop catches it
 * and reads again); on Android HttpURLConnection is OkHttp, where a read
 * timeout is fatal and closes the socket -- which surfaces as "timeout" or
 * "Socket closed". So the question this answers is factual and needs no
 * Android device: is the first byte slower than the read timeout?
 *
 *   java -cp <out>:<json jar> TtfbProbe <credentials.properties> <slot> [prompt]
 */
public final class TtfbProbe {

    public static void main(String[] args) throws Exception {
        Properties p = new Properties();
        try (FileInputStream in = new FileInputStream(args[0])) { p.load(in); }
        String topic = p.getProperty("beaconTopic");
        String slot = args[1].toLowerCase(Locale.ROOT);
        String prompt = args.length > 2 ? args[2] : "Reply with one short sentence.";
        String offKey = p.getProperty("offKey");

        String url = null;
        for (String u : EngineCore.urlsFor(topic, "", slot, 3 * 3600, 12_000, 8)) {
            EngineCore.Health h = EngineCore.health(u, 8_000);
            if (h.status == 200 && !h.models.isEmpty()) { url = u; break; }
        }
        if (url == null) { System.out.println("no live engine for " + slot); return; }
        System.out.println("engine " + slot.toUpperCase(Locale.ROOT) + " is live, probing "
                + url.replaceAll("https?://", "").replaceAll("\\..*", ".***") + "/api/chat");

        String body = "{\"stream\":true,\"messages\":[{\"role\":\"user\","
                + "\"content\":" + quote(prompt) + "}]}";
        byte[] out = body.getBytes(StandardCharsets.UTF_8);

        /* Generous socket timeouts: we are MEASURING, so nothing may cut us off. */
        HttpURLConnection c = (HttpURLConnection) new URL(url.replaceAll("/+$", "") + "/api/chat")
                .openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(30_000);
        c.setReadTimeout(600_000);
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("Accept", "application/x-ndjson");
        c.setRequestProperty("X-Engine-Key", offKey);
        c.setDoOutput(true);
        c.setFixedLengthStreamingMode(out.length);

        long t0 = System.currentTimeMillis();
        try (OutputStream os = c.getOutputStream()) { os.write(out); }
        long sent = System.currentTimeMillis() - t0;

        int status = c.getResponseCode();
        long headers = System.currentTimeMillis() - t0;
        System.out.println("HTTP " + status + "  (request sent in " + sent + "ms, headers in "
                + headers + "ms)");
        if (status != 200) { System.out.println("no stream to measure"); return; }

        long firstByte = -1, lastEvent = System.currentTimeMillis(), longestGap = 0;
        int lines = 0, contentChars = 0, thinkingLines = 0;
        StringBuilder text = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(
                c.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                long now = System.currentTimeMillis();
                if (firstByte < 0) firstByte = now - t0;
                longestGap = Math.max(longestGap, now - lastEvent);
                lastEvent = now;
                lines++;
                if (line.trim().isEmpty()) continue;
                if (line.contains("\"thinking\"")) thinkingLines++;
                if (line.contains("\"content\"")) {
                    int i = line.indexOf("\"content\":\"");
                    if (i >= 0) contentChars += Math.max(0, line.length() - i - 11);
                    text.append('.');
                }
                if (line.contains("\"done\":true")) break;
            }
        }
        long total = System.currentTimeMillis() - t0;
        System.out.println();
        System.out.println("  TIME TO FIRST BYTE        " + firstByte + " ms");
        System.out.println("  longest silent gap inside  " + longestGap + " ms");
        System.out.println("  stream lines / thinking / content chunks  " + lines
                + " / " + thinkingLines + " / " + text.length());
        System.out.println("  total turn                 " + total + " ms");
        System.out.println();
        System.out.println("  the app's read timeout is  " + 1000 + " ms");
        System.out.println("  VERDICT: first byte is " + (firstByte > 1000 ? "SLOWER" : "faster")
                + " than the read timeout -> "
                + (firstByte > 1000
                        ? "the read times out before the reply starts"
                        : "the first byte fits inside the read timeout"));
    }

    private static String quote(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (char ch : s.toCharArray()) {
            if (ch == '"') b.append("\\\"");
            else if (ch == '\\') b.append("\\\\");
            else if (ch == '\n') b.append("\\n");
            else b.append(ch);
        }
        return b.append('"').toString();
    }
}
