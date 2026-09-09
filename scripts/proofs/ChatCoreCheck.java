import com.aether.app.core.Attachment;
import com.aether.app.core.ChatMessage;
import com.aether.app.core.ChatSession;
import com.aether.app.core.ChatStore;
import com.aether.app.core.TextNormalizer;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;

/**
 * JVM check of the chat core the APK ships: history persistence, session model
 * and output normalisation.
 *
 * These are the SHIPPED classes in
 * android/app/src/main/java/com/aether/app/core -- imported, not copied. They
 * are pure Java on purpose so this can run them for real, which matters because
 * no emulator can run in this sandbox: the alternative is shipping persistence
 * and text handling that nobody has ever executed.
 *
 * Run:
 *   javac -cp $T/jars/json-20240303.jar -d /tmp/cc \
 *     android/app/src/main/java/com/aether/app/core/*.java scripts/proofs/ChatCoreCheck.java
 *   java  -cp /tmp/cc:$T/jars/json-20240303.jar ChatCoreCheck
 */
public final class ChatCoreCheck {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) throws Exception {
        File tmp = Files.createTempDirectory("aether-chats").toFile();
        ChatStore store = new ChatStore(new File(tmp, "chats"));

        normalizerChecks();
        storeChecks(store);
        sessionChecks(store);
        securityChecks(store);

        System.out.println();
        System.out.println("CHAT CORE CHECK  " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    // -------------------------------------------------------- normalizer

    private static void normalizerChecks() {
        section("TextNormalizer -- what reaches the screen");

        check("ANSI colour codes removed",
                TextNormalizer.normalize("plain \u001B[32mGREEN\u001B[0m text").equals("plain GREEN text"),
                TextNormalizer.normalize("plain \u001B[32mGREEN\u001B[0m text"));

        check("OSC window-title sequence removed",
                TextNormalizer.normalize("a\u001B]0;title\u0007b").equals("ab"),
                TextNormalizer.normalize("a\u001B]0;title\u0007b"));

        String emojied = TextNormalizer.normalize(
                "Here you go! \uD83C\uDF89\u2705 Done \uD83D\uDD25 check \u26A0\uFE0F now");
        check("emoji and variation selectors removed, words kept",
                emojied.equals("Here you go!  Done  check  now") || emojied.equals("Here you go! Done check now"),
                "[" + emojied + "]");

        check("flag pairs (regional indicators) removed",
                !TextNormalizer.normalize("ship to \uD83C\uDDF3\uD83C\uDDEC today")
                        .contains("\uD83C\uDDF3"),
                "[" + TextNormalizer.normalize("ship to \uD83C\uDDF3\uD83C\uDDEC today") + "]");

        check("zero-width, bidi and BOM characters removed",
                TextNormalizer.normalize("a\u200Bb\uFEFFc\u202Ed").equals("abcd"),
                "[" + TextNormalizer.normalize("a\u200Bb\uFEFFc\u202Ed") + "]");

        check("control bytes removed but newline and tab kept",
                TextNormalizer.normalize("a\u0000b\u0007c\td\ne").equals("abc\td\ne"),
                "[" + TextNormalizer.normalize("a\u0000b\u0007c\td\ne") + "]");

        check("CRLF normalised to LF",
                TextNormalizer.normalize("one\r\ntwo\rthree").equals("one\ntwo\nthree"),
                "[" + TextNormalizer.normalize("one\r\ntwo\rthree") + "]");

        check("runs of blank lines collapsed to one",
                TextNormalizer.normalize("a\n\n\n\n\n\nb").equals("a\n\nb"),
                "[" + TextNormalizer.normalize("a\n\n\n\n\n\nb") + "]");

        check("trailing spaces on every line trimmed",
                TextNormalizer.normalize("one   \ntwo  \n").equals("one\ntwo"),
                "[" + TextNormalizer.normalize("one   \ntwo  \n") + "]");

        check("null input returns empty string",
                TextNormalizer.normalize(null).isEmpty(), "null -> \"" + TextNormalizer.normalize(null) + "\"");

        section("TextNormalizer -- the model's reasoning delimiters never reach the chat");

        /* The exact shape measured live on engine C: a stray closing marker
           inside an otherwise ordinary one-line answer. */
        check("stray closing marker removed, answer kept",
                TextNormalizer.normalize("Paris is the capital of France. </think>")
                        .equals("Paris is the capital of France."),
                "[" + TextNormalizer.normalize("Paris is the capital of France. </think>") + "]");

        check("reasoning between a matched pair is dropped, answer kept",
                TextNormalizer.normalize("The answer is 42.\n<think>let me count 40 + 2</think>\nDone.")
                        .equals("The answer is 42.\n\nDone."),
                "[" + TextNormalizer.normalize("The answer is 42.\n<think>let me count 40 + 2</think>\nDone.") + "]");

        check("an unterminated opening marker still cannot leak",
                TextNormalizer.normalize("Answer <think>reasoning that never ended")
                        .equals("Answer reasoning that never ended"),
                "[" + TextNormalizer.normalize("Answer <think>reasoning that never ended") + "]");

        check("back-to-back reasoning blocks are both removed",
                TextNormalizer.normalize("A<think>r1</think>B<think>r2</think>C").equals("ABC"),
                "[" + TextNormalizer.normalize("A<think>r1</think>B<think>r2</think>C") + "]");

        check("reasoning words do not survive into the answer",
                !TextNormalizer.normalize("ok <think>withdraw the bold plan</think> done").contains("withdraw"),
                "[" + TextNormalizer.normalize("ok <think>withdraw the bold plan</think> done") + "]");

        check("the word think in ordinary prose is untouched",
                TextNormalizer.normalize("I think this is right, don't you think?")
                        .equals("I think this is right, don't you think?"),
                "[" + TextNormalizer.normalize("I think this is right, don't you think?") + "]");

        check("a less-than sign in real content survives",
                TextNormalizer.normalize("if x < 10 then stop").equals("if x < 10 then stop"),
                "[" + TextNormalizer.normalize("if x < 10 then stop") + "]");

        check("stripping is idempotent",
                TextNormalizer.stripThinkMarkers(TextNormalizer.stripThinkMarkers("A<think>r</think>B"))
                        .equals(TextNormalizer.stripThinkMarkers("AB")),
                "idempotence");

        section("TextNormalizer -- markdown flattened for a plain TextView");

        check("**bold** shown as words, not asterisks",
                TextNormalizer.normalize("this is **important** now").equals("this is important now"),
                "[" + TextNormalizer.normalize("this is **important** now") + "]");

        check("heading hashes dropped, words kept",
                TextNormalizer.normalize("## Summary").equals("Summary"),
                "[" + TextNormalizer.normalize("## Summary") + "]");

        check("blockquote marker dropped",
                TextNormalizer.normalize("> quoted line").equals("quoted line"),
                "[" + TextNormalizer.normalize("> quoted line") + "]");

        check("link kept as text (url)",
                TextNormalizer.normalize("see [docs](https://x.dev/a)").equals("see docs (https://x.dev/a)"),
                "[" + TextNormalizer.normalize("see [docs](https://x.dev/a)") + "]");

        check("inline backticks dropped",
                TextNormalizer.normalize("run `ls -la` now").equals("run ls -la now"),
                "[" + TextNormalizer.normalize("run `ls -la` now") + "]");

        check("horizontal rule removed",
                TextNormalizer.normalize("above\n---\nbelow").equals("above\n\nbelow"),
                "[" + TextNormalizer.normalize("above\n---\nbelow") + "]");

        String code = TextNormalizer.normalize("```bash\nif [ $x = *y* ]; then echo \"**not bold**\"; fi\n```");
        check("fence markers dropped, code inside untouched",
                code.equals("if [ $x = *y* ]; then echo \"**not bold**\"; fi"),
                "[" + code + "]");

        check("list bullets survive (not eaten as italic markers)",
                TextNormalizer.normalize("* first\n* second").equals("* first\n* second"),
                "[" + TextNormalizer.normalize("* first\n* second") + "]");

        section("TextNormalizer -- meaning preserved");

        check("box drawing kept (tables stay readable)",
                TextNormalizer.normalize("\u2502 a \u2502 b \u2502\n\u251C\u2500\u2534\u2500\u2524")
                        .equals("\u2502 a \u2502 b \u2502\n\u251C\u2500\u2534\u2500\u2524"),
                "[" + TextNormalizer.normalize("\u2502 a \u2502 b \u2502") + "]");

        check("arrows kept",
                TextNormalizer.normalize("A \u2192 B \u21D2 C").equals("A \u2192 B \u21D2 C"),
                "[" + TextNormalizer.normalize("A \u2192 B \u21D2 C") + "]");

        check("user input keeps their emoji and markdown",
                TextNormalizer.userInput("fix **this** \uD83D\uDE00 please\u200B").equals("fix **this** \uD83D\uDE00 please"),
                "[" + TextNormalizer.userInput("fix **this** \uD83D\uDE00 please\u200B") + "]");

        section("TextNormalizer -- titles");

        check("title takes the first line",
                TextNormalizer.title("first line\nsecond line", 40).equals("first line"),
                TextNormalizer.title("first line\nsecond line", 40));

        check("empty prompt becomes 'New chat'",
                TextNormalizer.title("   \n  ", 40).equals("New chat"),
                TextNormalizer.title("   \n  ", 40));

        check("emoji-only prompt becomes 'New chat'",
                TextNormalizer.title("\uD83D\uDD25\uD83D\uDD25", 40).equals("New chat"),
                TextNormalizer.title("\uD83D\uDD25\uD83D\uDD25", 40));

        String longTitle = TextNormalizer.title(
                "the quick brown fox jumps over the lazy dog and keeps running", 20);
        check("long title capped with ellipsis",
                longTitle.length() == 20 && longTitle.endsWith("\u2026"),
                "[" + longTitle + "] len=" + longTitle.length());

        check("title never ends on a broken surrogate pair",
                TextNormalizer.title("abcdef\uD83D\uDE00ghij", 7).endsWith("\u2026")
                        && !Character.isLowSurrogate(
                                TextNormalizer.title("abcdef\uD83D\uDE00ghij", 7).charAt(5)),
                "[" + TextNormalizer.title("abcdef\uD83D\uDE00ghij", 7) + "]");
    }

    // ------------------------------------------------------------- store

    private static void storeChecks(ChatStore store) throws Exception {
        section("ChatStore -- history on the phone");

        ChatSession a = store.create("Explain the failover order");
        addTurn(a, "Explain the failover order", "A then B then C.");
        store.save(a);

        ChatSession b = store.create("Write a haiku about GPUs");
        addTurn(b, "Write a haiku about GPUs", "Silicon dreams hum.");
        store.save(b);

        /* Force a deterministic ordering: b is the newest. */
        Thread.sleep(5);
        addTurn(b, "another", "more");
        store.save(b);

        List<ChatStore.Meta> metas = store.list();
        check("two chats listed", metas.size() == 2, "got " + metas.size());
        check("newest chat first", metas.get(0).id.equals(b.id),
                "first=" + metas.get(0).title);
        check("list carries the derived title",
                metas.get(1).title.equals("Explain the failover order"),
                metas.get(1).title);
        check("list carries the message count", metas.get(1).messageCount == 2,
                "count=" + metas.get(1).messageCount);
        check("transcript files are on disk", store.countFiles() == 2,
                "files=" + store.countFiles());

        ChatSession loaded = store.load(a.id);
        check("load round-trips the messages",
                loaded != null && loaded.messages.size() == 2, "loaded=" + loaded);
        check("load round-trips the assistant reply",
                loaded != null && loaded.messages.get(1).content.equals("A then B then C."),
                loaded == null ? "null" : loaded.messages.get(1).content);

        /* The three zones must survive a save/load cycle. */
        ChatMessage m = loaded.messages.get(1);
        m.thinking = "considered the order";
        m.toolLines.add("web_search: failover");
        m.status = ChatMessage.STATUS_STOPPED;
        m.note = "user pressed stop";
        m.engine = "b";
        m.attachments.add(new Attachment("att1", "notes.txt", 12, "text/plain", "hello", true));
        store.save(loaded);
        ChatSession again = store.load(a.id);
        check("thinking survives the round trip",
                again.messages.get(1).thinking.equals("considered the order"),
                again.messages.get(1).thinking);
        check("tool lines survive the round trip",
                again.messages.get(1).toolLines.size() == 1
                        && again.messages.get(1).toolLines.get(0).equals("web_search: failover"),
                String.valueOf(again.messages.get(1).toolLines));
        check("status and note survive the round trip",
                again.messages.get(1).status.equals(ChatMessage.STATUS_STOPPED)
                        && "user pressed stop".equals(again.messages.get(1).note),
                again.messages.get(1).status + "/" + again.messages.get(1).note);
        check("engine attribution survives the round trip",
                "b".equals(again.messages.get(1).engine), String.valueOf(again.messages.get(1).engine));
        check("attachment metadata survives the round trip",
                again.messages.get(1).attachments.size() == 1
                        && again.messages.get(1).attachments.get(0).name.equals("notes.txt")
                        && again.messages.get(1).attachments.get(0).sentToEngine,
                String.valueOf(again.messages.get(1).attachments));

        check("no temp files left behind after saving",
                countTmp(store.dir()) == 0, "tmp files=" + countTmp(store.dir()));

        /* Rename */
        check("rename reports success", store.rename(a.id, "  Failover notes  "), "");
        check("rename trims and persists",
                "Failover notes".equals(titleOf(store, a.id)), titleOf(store, a.id));
        check("renaming brings the chat to the top of the drawer",
                store.list().get(0).id.equals(a.id), store.list().get(0).title);
        check("rename locks the title", store.load(a.id).titleLocked, "titleLocked");
        check("rename of a missing chat reports failure",
                !store.rename("deadbeefdeadbeef", "nope"), "");

        /* Corrupt file tolerance */
        File junk = new File(store.dir(), "cafebabecafebabe.json");
        Files.write(junk.toPath(), "{ not json at all".getBytes(StandardCharsets.UTF_8));
        List<ChatStore.Meta> afterJunk = store.list();
        check("a corrupt transcript does not break the list",
                afterJunk.size() == 2, "listed=" + afterJunk.size());
        check("corrupt file is skipped, not fatal",
                store.load("cafebabecafebabe") == null, "load returned non-null");

        /* Index rebuild */
        new File(store.dir(), "index.json").delete();
        List<ChatStore.Meta> rebuilt = store.list();
        check("index rebuilds from disk when deleted", rebuilt.size() == 2,
                "listed=" + rebuilt.size());
        check("rebuilt index is written back",
                new File(store.dir(), "index.json").isFile(), "index.json missing");

        /* Delete */
        File kept = store.storeAttachment(b.id, "keep me".getBytes(StandardCharsets.UTF_8), "keep.txt");
        File gone = store.storeAttachment(a.id, "drop me".getBytes(StandardCharsets.UTF_8), "drop.txt");
        check("attachments are stored under the chat id",
                kept != null && gone != null && kept.exists() && gone.exists(),
                kept + " / " + gone);
        check("delete removes the transcript", store.delete(a.id), "");
        check("deleted chat is gone from the list", store.list().size() == 1,
                "listed=" + store.list().size());
        check("delete removes that chat's attachments", !gone.exists(), "still present");
        check("delete keeps other chats' attachments", kept.exists(), "removed");
        check("delete twice reports false the second time",
                !store.delete(a.id), "");
        check("deleteAll clears every transcript and leaves the index",
                store.deleteAll() == 2 && store.list().isEmpty()
                        && new File(store.dir(), "index.json").isFile(),
                "listed=" + store.list().size());
    }

    // ----------------------------------------------------------- sessions

    private static void sessionChecks(ChatStore store) {
        section("ChatSession -- retry and preview");

        ChatSession s = store.create("first question");
        addTurn(s, "first question", "first answer");
        addTurn(s, "second question", "second answer");
        check("lastUserPrompt is the newest question",
                "second question".equals(s.lastUserPrompt()), String.valueOf(s.lastUserPrompt()));
        check("userPromptBefore finds the prompt above a reply",
                "second question".equals(s.userPromptBefore(3)), s.userPromptBefore(3));
        check("userPromptBefore walks back past earlier turns",
                "first question".equals(s.userPromptBefore(1)), s.userPromptBefore(1));
        check("preview shows the newest message",
                "second answer".equals(s.preview()), s.preview());

        ChatSession empty = new ChatSession(ChatStore.newId(), "x");
        check("empty session has no retry target",
                empty.lastUserPrompt() == null, String.valueOf(empty.lastUserPrompt()));
        check("empty session preview is blank", empty.preview().isEmpty(), "[" + empty.preview() + "]");

        ChatMessage blank = new ChatMessage(ChatMessage.ROLE_ASSISTANT);
        check("a turn with nothing streamed reports empty", blank.isEmpty(), "not empty");
        blank.content = "hi";
        check("a turn with content is not empty", !blank.isEmpty(), "empty");
    }

    // ---------------------------------------------------------- security

    private static void securityChecks(ChatStore store) {
        section("ChatStore -- hostile ids");

        check("path traversal id rejected", !ChatStore.isSafeId("../../evil"), "");
        check("null id rejected", !ChatStore.isSafeId(null), "");
        check("slash id rejected", !ChatStore.isSafeId("a/b"), "");
        check("normal id accepted", ChatStore.isSafeId("0123abcdef0123ab"), "");
        check("load with a traversal id returns null, not a file read",
                store.load("../../evil") == null, "returned non-null");
        check("attachment store rejects a traversal id",
                store.storeAttachment("../../evil", "x".getBytes(StandardCharsets.UTF_8), "f") == null,
                "stored outside the chat dir");

        File escaped = new File(store.dir().getParentFile(), "evil-x.txt");
        check("nothing escaped the storage directory", !escaped.exists(), "file was written");
    }

    // ----------------------------------------------------------- helpers

    private static void addTurn(ChatSession s, String prompt, String reply) {
        ChatMessage u = new ChatMessage(ChatMessage.ROLE_USER);
        u.content = prompt;
        s.messages.add(u);
        ChatMessage r = new ChatMessage(ChatMessage.ROLE_ASSISTANT);
        r.content = reply;
        r.engine = "a";
        s.messages.add(r);
    }

    private static String titleOf(ChatStore store, String id) {
        for (ChatStore.Meta m : store.list()) if (m.id.equals(id)) return m.title;
        return "(not listed)";
    }

    private static int countTmp(File dir) {
        String[] names = dir.list();
        int n = 0;
        if (names != null) for (String s : names) if (s.endsWith(".tmp")) n++;
        return n;
    }

    private static void section(String name) {
        System.out.println();
        System.out.println("== " + name);
    }

    private static void check(String name, boolean ok, String detail) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + name
                + (ok || detail == null || detail.isEmpty() ? "" : "  ->  " + detail));
        if (ok) pass++; else fail++;
    }
}
