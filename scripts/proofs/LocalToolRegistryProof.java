import com.aether.app.ByokAgent;
import com.aether.app.LocalToolRegistry;
import org.json.JSONObject;

import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.concurrent.atomic.AtomicBoolean;

/** Real filesystem/process checks for the on-device tool registry. */
public final class LocalToolRegistryProof {
    private static int passed, failed;
    private static void check(boolean value, String name) {
        if (value) { passed++; System.out.println("PASS " + name); }
        else { failed++; System.out.println("FAIL " + name); }
    }
    public static void main(String[] args) throws Exception {
        File root = Files.createTempDirectory("aether-local-tools").toFile();
        AtomicBoolean allow = new AtomicBoolean(false);
        LocalToolRegistry tools = new LocalToolRegistry(root, new ArrayList<>(),
                (action, detail) -> allow.get());
        check(tools.schemas().length() >= 8, "local schemas are advertised");

        ByokAgent.Result denied = tools.execute("write_file", new JSONObject().put("path", "note.txt").put("content", "secret-free proof"),
                chunk -> { }, new boolean[]{false});
        check(!denied.ok && !new File(root, "note.txt").exists(), "file write is denied without approval");
        allow.set(true);
        ByokAgent.Result written = tools.execute("write_file", new JSONObject().put("path", "docs/note.txt").put("content", "line one\nline two\n"),
                chunk -> { }, new boolean[]{false});
        check(written.ok && new File(root, "docs/note.txt").isFile(), "approved write creates real file");
        ByokAgent.Result read = tools.execute("read_file", new JSONObject().put("path", "docs/note.txt"), chunk -> { }, new boolean[]{false});
        check(read.ok && read.content.contains("line two"), "read returns actual file contents");
        ByokAgent.Result listed = tools.execute("list_files", new JSONObject().put("path", "docs"), chunk -> { }, new boolean[]{false});
        check(listed.ok && listed.content.contains("note.txt"), "list sees actual workspace file");

        StringBuilder live = new StringBuilder();
        ByokAgent.Result echo = tools.execute("run_command", new JSONObject().put("command", "echo live-command-proof"),
                live::append, new boolean[]{false});
        check(echo.ok && echo.exitCode == 0, "allowlisted command exits zero");
        check(live.toString().contains("$ echo live-command-proof") && live.toString().contains("live-command-proof"),
                "command and stdout stream to UI listener");
        ByokAgent.Result cat = tools.execute("run_command", new JSONObject().put("command", "cat docs/note.txt"),
                chunk -> { }, new boolean[]{false});
        check(cat.ok && cat.content.contains("line one"), "process working directory is confined workspace");
        ByokAgent.Result injection = tools.execute("run_command", new JSONObject().put("command", "echo first; touch escaped.txt"),
                chunk -> { }, new boolean[]{false});
        check(injection.ok && !new File(root, "escaped.txt").exists(), "shell metacharacters are arguments, not shell execution");
        ByokAgent.Result disallowed = tools.execute("run_command", new JSONObject().put("command", "sh -c echo bad"),
                chunk -> { }, new boolean[]{false});
        check(!disallowed.ok, "arbitrary shell is rejected");
        boolean grepFileBlocked = false;
        try {
            tools.execute("run_command", new JSONObject().put("command", "grep -f /etc/passwd docs/note.txt"), chunk -> { }, new boolean[]{false});
        } catch (Exception refused) { grepFileBlocked = true; }
        check(grepFileBlocked, "grep pattern-file option cannot escape workspace");
        boolean escapeBlocked = false;
        try {
            tools.execute("read_file", new JSONObject().put("path", "../../etc/passwd"), chunk -> { }, new boolean[]{false});
        } catch (Exception refused) {
            escapeBlocked = String.valueOf(refused.getMessage()).contains("escapes");
        }
        check(escapeBlocked, "path traversal is blocked");

        System.out.println(passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }
}
