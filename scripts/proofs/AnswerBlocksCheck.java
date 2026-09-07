import com.aether.app.core.AnswerBlocks;
import com.aether.app.core.TextNormalizer;
import java.util.List;

/**
 * Proves the fenced-code path is actually reachable -- the bug was that
 * ChatActivity split the NORMALISED text, and TextNormalizer deletes the ```
 * markers, so splitCode never saw a fence and codeBlock() could never run.
 */
public final class AnswerBlocksCheck {
    static int pass = 0, fail = 0;

    static void check(String what, boolean ok, String seen) {
        System.out.println((ok ? "  ok   " : "  FAIL ") + what + "  -> " + seen);
        if (ok) pass++; else fail++;
    }

    static String shape(String raw) {
        StringBuilder sb = new StringBuilder();
        for (AnswerBlocks.Block b : AnswerBlocks.split(raw)) {
            if (sb.length() > 0) sb.append(" | ");
            sb.append(b.code ? "CODE[" : "TEXT[").append(b.text.replace("\n", "\\n")).append("]");
        }
        return sb.length() == 0 ? "(empty)" : sb.toString();
    }

    static AnswerBlocks.Block only(String raw) {
        List<AnswerBlocks.Block> l = AnswerBlocks.split(raw);
        return l.isEmpty() ? null : l.get(0);
    }

    public static void main(String[] a) {
        System.out.println("== the bug that existed: normalised text has no fences ==");
        String answer = "Here you go:\n```python\nprint('hi')\n```\nDone.";
        String normalized = TextNormalizer.normalize(answer);
        check("TextNormalizer really does delete the fence",
                !normalized.contains("```"), "contains ``` = " + normalized.contains("```"));
        check("...so splitting NORMALISED text yields no code block",
                !AnswerBlocks.hasCode(normalized), shape(normalized));
        check("splitting the RAW text does yield one",
                AnswerBlocks.hasCode(answer), shape(answer));

        System.out.println("== a real fenced answer ==");
        List<AnswerBlocks.Block> blocks = AnswerBlocks.split(answer);
        check("three blocks: prose, code, prose", blocks.size() == 3,
                blocks.size() + " blocks -> " + shape(answer));
        check("first is prose", !blocks.get(0).code, blocks.get(0).text);
        check("second is code", blocks.get(1).code, blocks.get(1).text);
        check("language tag dropped", !blocks.get(1).text.contains("python"),
                blocks.get(1).text);
        check("code body preserved exactly", "print('hi')".equals(blocks.get(1).text),
                "'" + blocks.get(1).text + "'");
        check("third is prose", !blocks.get(2).code, blocks.get(2).text);

        System.out.println("== code content survives untouched ==");
        String tricky = "Use:\n```bash\nif [ -f x ]; then echo '*not bold* #not a heading `not code`'; fi\n```";
        AnswerBlocks.Block cb = AnswerBlocks.split(tricky).get(1);
        check("markdown characters inside code are kept",
                cb.text.contains("*not bold*") && cb.text.contains("#not a heading")
                        && cb.text.contains("`not code`"), cb.text);

        String indented = "```\nfor i in range(3):\n    print(i)\n```";
        check("indentation kept", AnswerBlocks.split(indented).get(0).text
                .contains("\n    print(i)"), AnswerBlocks.split(indented).get(0).text);

        System.out.println("== unbalanced fences must not swallow the answer ==");
        String stray = "Run `npm ci` then ``` and keep talking normally.";
        check("one stray fence stays prose", !AnswerBlocks.hasCode(stray), shape(stray));
        AnswerBlocks.Block sb = only(stray);
        check("...and nothing is lost", sb != null && sb.text.contains("keep talking normally"),
                shape(stray));

        String odd = "a\n```js\ncode1\n```\nb\n```js\ncode2 never closed";
        List<AnswerBlocks.Block> ob = AnswerBlocks.split(odd);
        boolean firstIsCode = ob.size() > 1 && ob.get(1).code;
        boolean lastIsProse = !ob.get(ob.size() - 1).code;
        check("odd fence count: the closed pair is code", firstIsCode, shape(odd));
        check("odd fence count: the unclosed tail is prose", lastIsProse, shape(odd));

        System.out.println("== edges ==");
        check("empty input", AnswerBlocks.split("").isEmpty(), shape(""));
        check("null input", AnswerBlocks.split(null).isEmpty(), "ok");
        check("plain prose only", !AnswerBlocks.hasCode("Just a normal answer."),
                shape("Just a normal answer."));
        AnswerBlocks.Block pb = only("**Bold** and a [link](https://x.test)");
        check("prose is still normalised", pb != null && !pb.text.contains("**")
                && !pb.text.contains("]("), pb == null ? "null" : pb.text);
        check("emoji dropped from prose", !only("Hi \uD83D\uDE00 there").text
                .contains("\uD83D\uDE00"), only("Hi \uD83D\uDE00 there").text);
        check("empty code block produces no block",
                AnswerBlocks.split("before\n```\n```\nafter").size() == 1,
                shape("before\n```\n```\nafter"));

        System.out.println("\n" + pass + " passed, " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }
}
