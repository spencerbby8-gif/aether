package com.aether.app.core;

import java.util.Locale;

/**
 * Prepares an attached file's text for the model.
 *
 * The engine has no upload endpoint, so the only way this model reads a file is
 * for its text to travel inside the prompt. That makes the size decision a
 * correctness question rather than a convenience one: a file that is too large
 * to send whole used to be dropped silently, which left the model holding an
 * attachment it could not see and no reason to say so, so it answered as though
 * it had read the file.
 *
 * The policy here is: send it whole when it fits; otherwise send the head and
 * the tail and state exactly how much was omitted, so the model can say "I only
 * have the first and last part of this" instead of inventing the middle.
 */
public final class AttachmentText {

    /** Files at or under this size are inlined whole. */
    public static final int INLINE_MAX_BYTES = 200_000;

    private AttachmentText() {}

    /** The prepared text, or null when the attachment carries none. */
    public static final class Prepared {
        public final String text;
        /** True when `text` was folded into the prompt sent to the engine. */
        public final boolean sentToEngine;
        /** True when the middle of the file was left out. */
        public final boolean truncated;
        /** Characters omitted, 0 when nothing was. */
        public final int omitted;
        /** Total characters in the normalized source text. */
        public final int sourceChars;

        Prepared(String text, boolean sentToEngine, boolean truncated,
                 int omitted, int sourceChars) {
            this.text = text;
            this.sentToEngine = sentToEngine;
            this.truncated = truncated;
            this.omitted = omitted;
            this.sourceChars = sourceChars;
        }
    }

    /** Nothing was extracted: a binary file, or an empty one. */
    public static Prepared none(int sourceChars) {
        return new Prepared(null, false, false, 0, sourceChars);
    }

    /** Formats whose bytes are not text the model can read. */
    private static final String[] BINARY_HINTS = {
        "pdf", "zip", "gz", "tar", "rar", "7z", "png", "jpg", "jpeg", "gif",
        "webp", "bmp", "mp3", "wav", "mp4", "mov", "docx", "xlsx", "pptx",
    };

    /**
     * True when the attachment is a format this engine genuinely cannot read.
     *
     * Reporting this matters more than it looks. A binary attachment used to
     * arrive with no text and no reason, so the model saw a file it could not
     * open and had nothing telling it so -- which is how it ends up describing
     * a PDF it never read. Naming the limitation lets it say "I can't read this
     * format" instead of inventing the contents.
     */
    public static boolean isUnsupportedBinary(String mime, String name) {
        String m = mime == null ? "" : mime.toLowerCase(Locale.US);
        String n = name == null ? "" : name.toLowerCase(Locale.US);
        /* Binary hints are checked FIRST, and this order is load-bearing. An
           Office document's mime type is
           application/vnd.openxmlformats-officedocument.wordprocessingml.document
           -- it contains "xml", so testing the text hints first classified a
           .docx as readable text and the model was handed ZIP bytes it could
           not parse. Caught by the proof, not by reading the code. */
        for (String h : BINARY_HINTS) {
            if (m.contains(h) || n.endsWith("." + h)) return true;
        }
        if (m.startsWith("text/") || m.contains("json") || m.contains("xml")
                || m.contains("javascript") || m.contains("yaml") || m.contains("csv")) {
            return false;
        }
        /* application/octet-stream and anything else unrecognized: not text we
           can promise to read. */
        return m.isEmpty() || m.startsWith("application/") || m.startsWith("image/")
                || m.startsWith("audio/") || m.startsWith("video/");
    }

    /**
     * The sentence that stands in for a file the engine cannot read, so the
     * model is told plainly instead of being left to guess.
     */
    public static String unsupportedNotice(String name, long size, String mime) {
        return "[The user attached \"" + name + "\" ("
                + size + " bytes, " + (mime == null ? "unknown type" : mime)
                + "). This is a binary format this engine cannot read: there is no "
                + "text extraction for it and its contents were not sent. Say so "
                + "rather than describing what the file might contain. If the user "
                + "needs it processed, ask for a text, Markdown, JSON, CSV or "
                + "source-code version.]";
    }

    /**
     * Fit `raw` into the inline budget.
     *
     * The head gets three quarters of the budget and the tail one quarter. An
     * opening usually states what a file is; an ending usually holds its
     * conclusion or its most recent records. Both matter more than the middle.
     */
    public static Prepared prepare(String raw) {
        if (raw == null || raw.isEmpty()) return none(0);
        int n = raw.length();
        if (n <= INLINE_MAX_BYTES) {
            return new Prepared(raw, true, false, 0, n);
        }
        int head = INLINE_MAX_BYTES * 3 / 4;
        int tail = INLINE_MAX_BYTES / 4;
        if (head + tail >= n) {
            /* Cannot happen while n > INLINE_MAX_BYTES, but the guard keeps the
               substring calls safe if the budget is ever retuned. */
            return new Prepared(raw, true, false, 0, n);
        }
        int omitted = n - head - tail;
        String body = raw.substring(0, head)
                + "\n\n[... " + String.format(Locale.US, "%,d", omitted)
                + " characters omitted from the middle of this "
                + String.format(Locale.US, "%,d", n)
                + "-character file: too large to send whole. Ask for a specific"
                + " section and it can be sent on its own.]\n\n"
                + raw.substring(n - tail);
        return new Prepared(body, true, true, omitted, n);
    }
}
