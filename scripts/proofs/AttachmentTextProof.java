import com.aether.app.core.AttachmentText;
import com.aether.app.core.AttachmentText.Prepared;

/** The attachment size policy, checked on real strings of real sizes. */
public class AttachmentTextProof {
    static int pass = 0, fail = 0;
    static void check(String name, boolean ok) {
        if (ok) { pass++; } else { fail++; System.out.println("  FAIL " + name); }
    }
    static String rep(char c, int n) {
        StringBuilder b = new StringBuilder(n);
        for (int i = 0; i < n; i++) b.append(c);
        return b.toString();
    }
    public static void main(String[] a) {
        /* A small file is sent whole and marked as sent. */
        Prepared small = AttachmentText.prepare("hello world");
        check("small file sent whole", "hello world".equals(small.text));
        check("small file marked sent", small.sentToEngine);
        check("small file not truncated", !small.truncated);
        check("small file omits nothing", small.omitted == 0);

        /* Exactly at the budget still goes whole. */
        Prepared exact = AttachmentText.prepare(rep('x', AttachmentText.INLINE_MAX_BYTES));
        check("at-budget file sent whole", exact.text.length() == AttachmentText.INLINE_MAX_BYTES);
        check("at-budget file not truncated", !exact.truncated);

        /* One byte over must truncate rather than vanish. */
        Prepared over = AttachmentText.prepare(rep('y', AttachmentText.INLINE_MAX_BYTES + 1));
        check("over-budget file still has text", over.text != null && !over.text.isEmpty());
        check("over-budget file marked sent", over.sentToEngine);
        check("over-budget file flagged truncated", over.truncated);
        check("over-budget omission counted", over.omitted == 1);
        check("over-budget source size recorded",
                over.sourceChars == AttachmentText.INLINE_MAX_BYTES + 1);
        check("over-budget notice states the omission",
                over.text.contains("characters omitted from the middle"));
        /* The head and the tail must both survive. */
        check("head preserved", over.text.startsWith("y"));
        check("tail preserved", over.text.endsWith("y"));

        /* A large file keeps roughly three quarters head, one quarter tail. */
        Prepared big = AttachmentText.prepare(rep('h', 300_000) + rep('t', 300_000));
        int headEnd = big.text.indexOf("\n\n[...");
        int tailStart = big.text.lastIndexOf("]\n\n") + 3;
        check("big file head is ~3/4 of budget",
                Math.abs(headEnd - (AttachmentText.INLINE_MAX_BYTES * 3 / 4)) <= 2);
        check("big file tail is ~1/4 of budget",
                Math.abs((big.text.length() - tailStart) - (AttachmentText.INLINE_MAX_BYTES / 4)) <= 2);
        check("big file head is from the start", big.text.charAt(0) == 'h');
        check("big file tail is from the end", big.text.charAt(big.text.length() - 1) == 't');
        check("big file omitted 400000", big.omitted == 600_000 - AttachmentText.INLINE_MAX_BYTES);

        /* Null and empty produce nothing, and say nothing was sent. */
        Prepared nul = AttachmentText.prepare(null);
        check("null yields no text", nul.text == null);
        check("null not marked sent", !nul.sentToEngine);
        Prepared empty = AttachmentText.prepare("");
        check("empty yields no text", empty.text == null);
        check("empty not marked sent", !empty.sentToEngine);

        /* none() is what a binary file gets. */
        Prepared bin = AttachmentText.none(12345);
        check("binary yields no text", bin.text == null);
        check("binary not marked sent", !bin.sentToEngine);
        check("binary records its size", bin.sourceChars == 12345);

        System.out.println("AttachmentTextProof: " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }
}
