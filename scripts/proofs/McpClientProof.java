import com.aether.app.McpClient;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

/** JSON-RPC lifecycle and tool invocation against a deterministic MCP peer. */
public final class McpClientProof {
    private static int passed, failed;
    private static void check(boolean value, String name) {
        if (value) { passed++; System.out.println("PASS " + name); }
        else { failed++; System.out.println("FAIL " + name); }
    }
    public static void main(String[] args) throws Exception {
        List<JSONObject> calls = new ArrayList<>();
        McpClient.Transport transport = (config, sessionId, body, notification, newSession) -> {
            JSONObject call = new JSONObject(body); calls.add(call);
            if (notification) return "{}";
            String method = call.getString("method"); int id = call.getInt("id");
            Object result;
            if ("initialize".equals(method)) {
                newSession.set("proof-session");
                result = new JSONObject().put("protocolVersion", "2025-06-18").put("capabilities", new JSONObject());
            } else if ("tools/list".equals(method)) {
                result = new JSONObject().put("tools", new JSONArray().put(new JSONObject().put("name", "search_issues")
                        .put("description", "Search project issues")
                        .put("inputSchema", new JSONObject().put("type", "object"))));
            } else if ("tools/call".equals(method)) {
                result = new JSONObject().put("content", new JSONArray().put(new JSONObject().put("type", "text")
                        .put("text", "Issue #42: live connector proof"))).put("isError", false);
            } else throw new Exception("unexpected method " + method);
            return "event: message\ndata: " + new JSONObject().put("jsonrpc", "2.0").put("id", id)
                    .put("result", result).toString() + "\n\n";
        };
        McpClient.Config config = new McpClient.Config(); config.url = "https://mcp.example.test/mcp"; config.token = "proof";
        McpClient client = new McpClient(config, transport);
        List<McpClient.Tool> tools = client.listTools();
        check(tools.size() == 1 && "search_issues".equals(tools.get(0).name), "tools/list discovers real schema");
        check("initialize".equals(calls.get(0).getString("method")), "initialize happens before discovery");
        check("notifications/initialized".equals(calls.get(1).getString("method")), "initialized notification is sent");
        McpClient.CallResult result = client.call("search_issues", new JSONObject().put("query", "live"));
        check(!result.isError && result.text.contains("Issue #42"), "tools/call returns text content");
        JSONObject invocation = calls.get(calls.size() - 1);
        check("search_issues".equals(invocation.getJSONObject("params").getString("name")), "remote tool name preserved");
        check("live".equals(invocation.getJSONObject("params").getJSONObject("arguments").getString("query")), "arguments reach server");
        System.out.println(passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }
}
