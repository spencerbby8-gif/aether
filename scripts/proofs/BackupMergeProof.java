import com.aether.app.core.*;
import org.json.JSONArray;
import java.io.File;
import java.nio.file.Files;

/** Backup export/merge proof: no cloud claim, just the real persistence logic. */
public final class BackupMergeProof {
    static int pass, fail;
    static void check(String name, boolean ok) { check(name, ok, ""); }
    static void check(String name, boolean ok, Object detail) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + name + "  [" + detail + "]");
        if (ok) pass++; else fail++;
    }
    public static void main(String[] args) throws Exception {
        File dir = Files.createTempDirectory("aether-backup-proof").toFile();
        ChatStore local = new ChatStore(dir);
        ChatSession chat = local.create("Local question");
        ChatMessage question = new ChatMessage(ChatMessage.ROLE_USER); question.content = "Local question";
        chat.messages.add(question);
        ChatMessage answer = new ChatMessage(ChatMessage.ROLE_ASSISTANT); answer.content = "Local answer"; answer.status = ChatMessage.STATUS_OK;
        chat.messages.add(answer); local.save(chat);
        JSONArray exported = local.exportSessions();
        check("export includes the complete transcript", exported.length() == 1 && exported.getJSONObject(0).getJSONArray("messages").length() == 2, exported);
        String serialized = exported.toString();
        check("export contains no auth/provider secret fields", !serialized.matches(".*(access_token|refresh_token|api_key|provider_token).*"), "secret field scan");

        ChatSession incoming = ChatSession.fromJson(exported.getJSONObject(0));
        incoming.updatedAt = chat.updatedAt - 5000;
        incoming.title = "Stale remote title";
        JSONArray older = new JSONArray().put(incoming.toJson());
        check("older remote copy cannot overwrite local", local.importSessions(older) == 0 && local.load(chat.id).title.equals(chat.title));

        ChatSession newer = ChatSession.fromJson(exported.getJSONObject(0));
        newer.updatedAt = chat.updatedAt + 5000; newer.title = "Recovered newer title";
        check("newer backup copy is merged", local.importSessions(new JSONArray().put(newer.toJson())) == 1);
        check("merged content is readable", local.load(chat.id).title.equals("Recovered newer title") && local.load(chat.id).messages.size() == 2);

        ChatSession second = ChatSession.fromJson(exported.getJSONObject(0)); second.id = "abcdef1234567890"; second.title = "Second device chat";
        check("new session from another device is imported", local.importSessions(new JSONArray().put(second.toJson())) == 1 && local.load(second.id) != null);
        check("invalid path-like session id is rejected", local.importSessions(new JSONArray().put(new JSONObjectId("../../bad").value)) == 0);
        System.out.println("\nBACKUP MERGE PROOF  " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }
    static final class JSONObjectId {
        final org.json.JSONObject value = new org.json.JSONObject();
        JSONObjectId(String id) { value.put("id", id).put("title", "bad").put("messages", new JSONArray()); }
    }
}
