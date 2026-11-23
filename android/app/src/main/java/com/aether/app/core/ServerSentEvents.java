package com.aether.app.core;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.Reader;
import java.util.Objects;

/** Incremental SSE framing. The caller owns the reader and interprets event data. */
public final class ServerSentEvents {
    private ServerSentEvents() {}

    @FunctionalInterface
    public interface EventHandler {
        /** Return false to stop after this event without reading another one. */
        boolean onEvent(String type, String data) throws IOException;
    }

    /**
     * Reads at most maxChars UTF-16 code units, failing closed on oversized input.
     * An event without a terminating blank line is discarded at EOF per SSE framing.
     * The caller must verify its protocol's terminal marker separately.
     */
    public static void read(Reader source, int maxChars, EventHandler handler) throws IOException {
        Objects.requireNonNull(source, "source");
        Objects.requireNonNull(handler, "handler");
        if (maxChars < 1) throw new IllegalArgumentException("maxChars must be positive");
        Reader input = source instanceof BufferedReader ? source : new BufferedReader(source);
        StringBuilder line = new StringBuilder();
        StringBuilder data = new StringBuilder();
        String type = "";
        boolean hasData = false;
        boolean skipLf = false;
        int consumed = 0;
        int ch;
        while ((ch = input.read()) != -1) {
            if (consumed == maxChars) throw new IOException("Provider stream exceeded its size limit.");
            consumed++;
            if (consumed == 1 && ch == '\uFEFF') continue;
            if (skipLf) {
                skipLf = false;
                if (ch == '\n') continue;
            }
            if (ch != '\r' && ch != '\n') {
                line.append((char) ch);
                continue;
            }
            skipLf = ch == '\r';
            if (line.length() == 0) {
                if (hasData && !handler.onEvent(type.isEmpty() ? "message" : type, data.toString())) return;
                data.setLength(0);
                type = "";
                hasData = false;
                continue;
            }
            int colon = line.indexOf(":");
            String field = colon < 0 ? line.toString() : line.substring(0, colon);
            int start = colon < 0 ? line.length() : colon + 1;
            if (start < line.length() && line.charAt(start) == ' ') start++;
            if ("data".equals(field)) {
                if (hasData) data.append('\n');
                data.append(line, start, line.length());
                hasData = true;
            } else if ("event".equals(field)) {
                type = line.substring(start);
            }
            line.setLength(0);
        }
    }
}
