package com.aether.app.core;

import java.util.regex.Pattern;

/**
 * Turns raw model output into something worth reading.
 *
 * WHY THIS EXISTS. The engines are uncensored Qwen builds on a Tesla P100 and
 * their raw stream routinely contains things that are not words: ANSI colour
 * escapes left over from tool output, zero-width joiners, variation selectors,
 * emoji and pictographs, stray control bytes, CRLF mixing, and trailing spaces
 * on every line. Displayed verbatim in a plain TextView that reads as junk.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never rewrites meaning: no
 * summarising, no "helpful preamble" removal, no word substitution, and it
 * leaves the inside of fenced code blocks alone apart from control characters
 * and emoji. Losing a character the model actually meant is worse than leaving
 * a character that looks odd.
 *
 * Pure Java on purpose -- no Android imports -- so the behaviour is checked on
 * the JVM by scripts/proofs/ChatCoreCheck.java rather than assumed.
 */
public final class TextNormalizer {

    /** ESC [ ... final byte -- SGR colour codes and cursor movement. */
    private static final Pattern ANSI_CSI =
            Pattern.compile("\u001B\\[[0-9;?]*[ -/]*[@-~]");

    /** ESC ] ... BEL or ESC \ -- operating system commands (window titles). */
    private static final Pattern ANSI_OSC =
            Pattern.compile("\u001B\\][^\u0007\u001B]*(?:\u0007|\u001B\\\\)");

    /** Any other single-byte control character except \n and \t. */
    private static final Pattern CONTROL =
            Pattern.compile("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]");

    private static final int MAX_BLANK_RUN = 2;

    private TextNormalizer() {}

    /**
     * Full pipeline: ANSI out, control bytes out, emoji and pictographs out,
     * invisible formatting characters out, markdown decoration flattened to
     * plain text, blank runs collapsed, trailing space trimmed per line.
     *
     * Safe on null (returns "").
     */
    public static String normalize(String raw) {
        if (raw == null) return "";
        String s = stripAnsi(raw);
        s = s.replace("\r\n", "\n").replace('\r', '\n');
        s = s.replace('\u00A0', ' ');
        s = CONTROL.matcher(s).replaceAll("");
        s = stripInvisible(s);
        s = stripThinkMarkers(s);
        s = stripEmoji(s);
        s = markdownToPlain(s);
        s = collapseBlankLines(s);
        return trimEdges(s);
    }

    /** Remove ANSI CSI and OSC sequences, and the bare escapes they leave. */
    public static String stripAnsi(String s) {
        if (s == null) return "";
        String out = ANSI_OSC.matcher(s).replaceAll("");
        out = ANSI_CSI.matcher(out).replaceAll("");
        return out.replace("\u001B", "");
    }

    /**
     * Remove emoji, pictographs, dingbats and the invisible characters that
     * accompany them (zero-width spaces/joiners, bidi controls, BOM,
     * variation selectors, regional indicators).
     *
     * Kept on purpose, because they carry meaning in technical output:
     * ASCII, arrows U+2190-U+21FF, bullets and dashes, box drawing
     * U+2500-U+257F, and mathematical symbols.
     */
    public static String stripEmoji(String s) {
        if (s == null) return "";
        StringBuilder out = new StringBuilder(s.length());
        int i = 0;
        while (i < s.length()) {
            int cp = s.codePointAt(i);
            if (!isDecorative(cp)) {
                out.appendCodePoint(cp);
            }
            i += Character.charCount(cp);
        }
        return out.toString();
    }

    /** Zero-width and bidi formatting characters. */
    public static String stripInvisible(String s) {
        if (s == null) return "";
        StringBuilder out = new StringBuilder(s.length());
        int i = 0;
        while (i < s.length()) {
            int cp = s.codePointAt(i);
            boolean drop =
                    (cp >= 0x200B && cp <= 0x200F)   // ZWSP..RLM
                 || (cp >= 0x202A && cp <= 0x202E)   // bidi embedding/override
                 || (cp >= 0x2060 && cp <= 0x2064)   // word joiner, invisible plus
                 || cp == 0xFEFF                     // BOM
                 || cp == 0x00AD;                    // soft hyphen
            if (!drop) out.appendCodePoint(cp);
            i += Character.charCount(cp);
        }
        return out.toString();
    }

    /** The model's own reasoning delimiters. Built in pieces only because a
     *  literal marker in this source would be confusing to read; the strings
     *  themselves are exactly the tags Qwen emits. */
    private static final String THINK_OPEN = "<think>";
    private static final String THINK_CLOSE = "</think>";

    /**
     * Remove the reasoning delimiters and the reasoning between a matched
     * pair.
     *
     * WHY. The engines are Qwen reasoning builds and they emit these markers
     * INSIDE the content stream, not in a separate channel. Measured live on
     * engine C: a plain "what is the capital of France" reply arrived as
     * 'Paris is the capital of France. </th''ink>  Pa...'. Nothing downstream
     * handled it, so the marker was rendered verbatim in the user's chat.
     *
     * The reasoning between a pair is dropped here rather than displayed: on
     * the native side the answer bubble is the product, and this normaliser's
     * contract is to never show markup the model emitted about itself. An
     * unterminated marker is removed as well, so a turn that ended
     * mid-reasoning still cannot leak a tag.
     *
     * Applied to the whole accumulated buffer, never to a single delta, so a
     * marker split across two chunks cannot survive: normalize() is called on
     * the full buffer at every render.
     */
    public static String stripThinkMarkers(String s) {
        if (s == null || s.isEmpty()) return "";
        String out = s;
        /* Matched pairs first, repeatedly: nested or back-to-back blocks. */
        boolean changed = true;
        while (changed) {
            changed = false;
            int open = out.indexOf(THINK_OPEN);
            while (open >= 0) {
                int close = out.indexOf(THINK_CLOSE, open + THINK_OPEN.length());
                if (close < 0) break;
                out = out.substring(0, open) + out.substring(close + THINK_CLOSE.length());
                changed = true;
                open = out.indexOf(THINK_OPEN);
            }
        }
        /* Whatever is left is a stray marker with no pair: drop the tag only,
         * never the text around it. */
        out = out.replace(THINK_OPEN, "").replace(THINK_CLOSE, "");
        return out;
    }

    private static boolean isDecorative(int cp) {
        return (cp >= 0x1F000 && cp <= 0x1FAFF)      // mahjong, cards, emoticons,
                                                     // transport, pictographs, symbols
            || (cp >= 0x1F1E6 && cp <= 0x1F1FF)      // regional indicators (flags)
            || (cp >= 0x2600 && cp <= 0x27BF)        // misc symbols and dingbats
            || (cp >= 0x2B00 && cp <= 0x2BFF)        // arrows, stars, squares
            || (cp >= 0x25A0 && cp <= 0x25FF)        // geometric shapes (triangles,
                                                     // play/stop markers, circles)
            || (cp >= 0xFE00 && cp <= 0xFE0F)        // variation selectors
            || (cp >= 0x1D000 && cp <= 0x1D24F)      // musical and math alphanumerics
            || cp == 0x2049 || cp == 0x203C          // ⁉ ‼
            || cp == 0x2122 || cp == 0x00AE || cp == 0x00A9; // ™ ® ©
    }

    /**
     * Flatten the markdown decoration that a plain TextView would otherwise
     * show literally, so the bubble reads as prose instead of markup.
     *
     * Fenced code blocks are passed through untouched: inside code, asterisks,
     * hashes and backticks are content, not formatting.
     */
    public static String markdownToPlain(String s) {
        if (s == null || s.isEmpty()) return "";
        String[] lines = s.split("\n", -1);
        StringBuilder out = new StringBuilder(s.length());
        boolean inFence = false;
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i];
            String trimmed = line.trim();
            boolean fence = trimmed.startsWith("```") || trimmed.startsWith("~~~");
            if (fence) {
                /* Drop the fence markers themselves; keep the code between. */
                inFence = !inFence;
                if (i > 0) out.append('\n');
                continue;
            }
            if (inFence) {
                if (i > 0) out.append('\n');
                out.append(line);
                continue;
            }
            if (i > 0) out.append('\n');
            out.append(plainLine(line));
        }
        return out.toString();
    }

    private static String plainLine(String line) {
        String l = line;

        /* A horizontal rule on its own line is decoration. */
        if (l.trim().matches("[-*_]{3,}")) return "";

        /* # Heading -> Heading (keep the words, drop the hashes) */
        l = l.replaceAll("^\\s{0,3}#{1,6}\\s+", "");

        /* > quote -> keep the text */
        l = l.replaceAll("^\\s{0,3}>\\s?", "");

        /* [text](url) -> text (url), so a link stays usable in plain text */
        l = l.replaceAll("\\[([^\\]]{1,200})\\]\\(([^)\\s]{1,300})\\)", "$1 ($2)");

        /* ![alt](url) -> alt (url) */
        l = l.replaceAll("!\\[([^\\]]{0,200})\\]\\(([^)\\s]{1,300})\\)", "$1 ($2)");

        /* **bold** and __bold__ -> bold */
        l = l.replaceAll("\\*\\*([^*\\n]{1,400})\\*\\*", "$1");
        l = l.replaceAll("__([^_\\n]{1,400})__", "$1");

        /* *italic* and _italic_ -> italic, but never touch a leading list bullet */
        l = l.replaceAll("(?<![*\\w])\\*([^*\\n]{1,400})\\*(?![*\\w])", "$1");

        /* `code` -> code (the mono tile already marks tool lines) */
        l = l.replaceAll("`([^`\\n]{1,400})`", "$1");

        /* Trailing whitespace, including the two-space hard break. */
        return l.replaceAll("\\s+$", "");
    }

    /** Collapse runs of blank lines to at most one empty line. */
    public static String collapseBlankLines(String s) {
        if (s == null) return "";
        StringBuilder out = new StringBuilder(s.length());
        int blanks = 0;
        for (String line : s.split("\n", -1)) {
            String t = line.replaceAll("\\s+$", "");
            if (t.isEmpty()) {
                blanks++;
                if (blanks > MAX_BLANK_RUN - 1) continue;
            } else {
                blanks = 0;
            }
            out.append(t).append('\n');
        }
        if (out.length() > 0) out.setLength(out.length() - 1);
        return out.toString();
    }

    private static String trimEdges(String s) {
        String t = s.trim();
        return t;
    }

    /**
     * Clean what the USER typed, which is a much lighter touch than model
     * output: invisible formatting and control bytes go, but emoji, markdown
     * and punctuation stay, because those are the user's own characters and
     * silently rewriting them would change what they asked for.
     */
    public static String userInput(String raw) {
        if (raw == null) return "";
        String s = stripAnsi(raw).replace("\r\n", "\n").replace('\r', '\n');
        s = CONTROL.matcher(s).replaceAll("");
        return trimEdges(stripInvisible(s));
    }

    /**
     * A one-line label for a chat list. First real line, whitespace collapsed,
     * emoji dropped, capped at max characters. Never returns an empty string.
     */
    public static String title(String prompt, int max) {
        String base = stripEmoji(stripInvisible(prompt == null ? "" : prompt)).trim();
        if (base.isEmpty()) return "New chat";
        int nl = base.indexOf('\n');
        if (nl > 0) base = base.substring(0, nl);
        base = base.replaceAll("\\s+", " ").trim();
        if (base.isEmpty()) return "New chat";
        if (max > 1 && base.length() > max) {
            base = base.substring(0, max - 1).trim();
            /* Do not cut in the middle of a code point. */
            if (!base.isEmpty() && Character.isLowSurrogate(base.charAt(base.length() - 1))) {
                base = base.substring(0, base.length() - 1);
            }
            base = base + "…";
        }
        return base;
    }
}
