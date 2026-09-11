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
