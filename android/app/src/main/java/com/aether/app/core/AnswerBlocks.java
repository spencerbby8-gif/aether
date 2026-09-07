package com.aether.app.core;

import java.util.ArrayList;
import java.util.List;

/**
 * Splits a raw model answer into prose and fenced-code blocks.
 *
 * This lives in core, not in the activity, for one reason: it has to run
 * BEFORE {@link TextNormalizer}. The normaliser deliberately drops ``` fence
 * markers ("keep the code between"), so splitting its output finds no fences
 * at all and every answer -- code included -- comes out as flattened prose.
 * That was a real bug in the first version of this: the code-block renderer
 * existed and could never fire.
 *
 * So: split the raw text here, then normalise only the prose blocks and leave
 * code alone apart from ANSI and invisible characters.
 */
public final class AnswerBlocks {

    public static final class Block {
        public final boolean code;
        public final String text;
        Block(boolean code, String text) { this.code = code; this.text = text; }
    }

    private static final String FENCE = "```";

    private AnswerBlocks() { }

    /** Prose and code blocks, in order. Never null, never an empty-text block. */
    public static List<Block> split(String raw) {
        List<Block> out = new ArrayList<>();
        if (raw == null || raw.isEmpty()) return out;

        int fences = 0;
        for (int at = raw.indexOf(FENCE); at >= 0; at = raw.indexOf(FENCE, at + FENCE.length())) {
            fences++;
        }
        /* A single stray fence is prose that happens to contain backticks.
           Turning the rest of the answer into a code block because of it is
           worse than leaving it alone. */
        if (fences < 2) {
            addProse(out, raw);
            return out;
        }

        String[] parts = raw.split(FENCE, -1);
        for (int i = 0; i < parts.length; i++) {
            String p = parts[i];
            if (i % 2 == 1) {
                /* Odd index is inside a fence -- unless the fence count was
                   odd, in which case the last one was never closed. */
                boolean closed = (fences % 2 == 0) || i < parts.length - 1;
                if (closed) { addCode(out, p); continue; }
            }
            addProse(out, p);
        }
        return out;
    }

    /** True when the answer contains at least one closed code block. */
    public static boolean hasCode(String raw) {
        for (Block b : split(raw)) if (b.code) return true;
        return false;
    }

    private static void addProse(List<Block> out, String p) {
        String t = TextNormalizer.normalize(p);
        if (t.isEmpty()) return;
        /* Prose either side of an empty (or dropped) fence is still one
           paragraph -- merge it rather than stacking two TextViews. */
        if (!out.isEmpty() && !out.get(out.size() - 1).code) {
            Block prev = out.get(out.size() - 1);
            out.set(out.size() - 1, new Block(false, prev.text + "\n" + t));
            return;
        }
        out.add(new Block(false, t));
    }

    private static void addCode(List<Block> out, String p) {
        String body = p;
        int nl = body.indexOf('\n');
        /* A short first line with no spaces is a language tag, not code. */
        if (nl >= 0 && nl < 24 && !body.substring(0, nl).trim().contains(" ")) {
            body = body.substring(nl + 1);
        }
        body = TextNormalizer.collapseBlankLines(
                TextNormalizer.stripInvisible(TextNormalizer.stripAnsi(body)));
        body = body.replaceAll("^\\s+", "").replaceAll("\\s+$", "");
        if (!body.isEmpty()) out.add(new Block(true, body));
    }
}
