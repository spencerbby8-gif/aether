import com.aether.app.ByokAgent;
import com.aether.app.ByokClient;
import com.aether.app.EngineCore;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/** Deterministic provider + tool transcript through the real Agent loop. */
public final class ByokAgentProof {
    private static int passed, failed;
    private static void check(boolean value, String name) {
        if (value) { passed++; System.out.println("PASS " + name); }
        else { failed++; System.out.println("FAIL " + name); }
    }

    public static void main(String[] args) throws Exception {
        List<JSONObject> requests = new ArrayList<>();
        List<String> events = new ArrayList<>();
        AtomicInteger executions = new AtomicInteger();
        ByokClient.Transport provider = new ByokClient.Transport() {
            @Override public ByokClient.Response execute(ByokClient.Request request, EngineCore.TurnHandle handle) {
                requests.add(new JSONObject(request.body));
                String body;
                if (requests.size() == 1) {
                    body = new JSONObject().put("choices", new JSONArray().put(new JSONObject().put("message", new JSONObject()
                            .put("role", "assistant").put("content", JSONObject.NULL)
                            .put("tool_calls", new JSONArray().put(new JSONObject().put("id", "call-live-1")
                                    .put("type", "function").put("function", new JSONObject().put("name", "run_command")
                                            .put("arguments", "{\"command\":\"echo live-proof\"}"))))))).toString();
                } else {
                    body = new JSONObject().put("choices", new JSONArray().put(new JSONObject().put("message", new JSONObject()
                            .put("role", "assistant").put("content", "Command finished and output was verified.")))).toString();
                }
                return response(200, body);
            }
        };
        ByokAgent.Tools tools = new ByokAgent.Tools() {
            @Override public JSONArray schemas() {
                return new JSONArray().put(new JSONObject().put("type", "function").put("function", new JSONObject()
                        .put("name", "run_command").put("description", "test")
                        .put("parameters", new JSONObject().put("type", "object"))));
            }
            @Override public ByokAgent.Result execute(String name, JSONObject arguments, ByokAgent.Output output, boolean[] cancelled) {
                if (!"run_command".equals(name)) return ByokAgent.Result.error("Unknown or unavailable tool: " + name);
                executions.incrementAndGet();
                output.write("live-proof\n");
                return ByokAgent.Result.ok("live-proof\n[exit 0]");
            }
        };
        ByokClient.Connection connection = new ByokClient.Connection();
        connection.provider = "openai"; connection.apiKey = "proof-not-a-live-key";
        ByokAgent.Listener listener = new ByokAgent.Listener() {
            @Override public void onIteration(int iteration) { events.add("iteration:" + iteration); }
            @Override public void onToolStart(String id, String name, String arguments) { events.add("start:" + id + ":" + name); }
            @Override public void onToolOutput(String id, String name, String output) { events.add("output:" + output.trim()); }
            @Override public void onToolEnd(String id, String name, String output, boolean ok, int exitCode) { events.add("end:" + ok + ":" + exitCode); }
            @Override public void onContent(String text) { events.add("content:" + text); }
            @Override public void onDone(boolean ok, String error) { events.add("done:" + ok + ":" + error); }
        };
        ByokAgent.chat(connection, "gpt-proof", new ArrayList<>(), "Run the proof", new ByokClient.ChatOptions(),
                tools, new boolean[]{false}, null, listener, provider);
        check(requests.size() == 2, "tool result triggers a second provider round");
        check(executions.get() == 1, "tool executes exactly once");
        check(requests.get(0).getJSONArray("tools").length() == 1, "function schema reaches provider");
        JSONArray followup = requests.get(1).getJSONArray("messages");
        JSONObject toolMessage = followup.getJSONObject(followup.length() - 1);
        check("tool".equals(toolMessage.getString("role")) && "call-live-1".equals(toolMessage.getString("tool_call_id")),
                "tool result is correlated to original call");
        check(toolMessage.getString("content").contains("live-proof"), "real output returns to model");
        check(events.contains("output:live-proof") && events.contains("end:true:0"), "live UI output and exit status emitted");
        check(events.get(events.size() - 1).equals("done:true:null"), "loop finishes successfully");
        check(events.contains("content:Command finished and output was verified."), "final answer reaches listener");

        // Unknown tools never execute; the model receives an honest error and can recover.
        List<String> recovery = new ArrayList<>();
        AtomicInteger calls = new AtomicInteger();
        ByokClient.Transport unknownProvider = new ByokClient.Transport() {
            @Override public ByokClient.Response execute(ByokClient.Request request, EngineCore.TurnHandle handle) {
                int round = calls.incrementAndGet();
                String body = round == 1
                        ? new JSONObject().put("choices", new JSONArray().put(new JSONObject().put("message", new JSONObject()
                        .put("tool_calls", new JSONArray().put(new JSONObject().put("id", "bad-1").put("function", new JSONObject()
                                .put("name", "not_registered").put("arguments", "{}"))))))).toString()
                        : new JSONObject().put("choices", new JSONArray().put(new JSONObject().put("message", new JSONObject()
                        .put("content", "The requested tool is unavailable.")))).toString();
                return response(200, body);
            }
        };
        ByokAgent.chat(connection, "gpt-proof", new ArrayList<>(), "Try it", new ByokClient.ChatOptions(), tools,
                new boolean[]{false}, null, new ByokAgent.Listener() {
                    @Override public void onIteration(int iteration) { }
                    @Override public void onToolStart(String id, String name, String arguments) { }
                    @Override public void onToolOutput(String id, String name, String output) { }
                    @Override public void onToolEnd(String id, String name, String output, boolean ok, int exitCode) { recovery.add(output); }
                    @Override public void onContent(String text) { }
                    @Override public void onDone(boolean ok, String error) { recovery.add("done=" + ok); }
                }, unknownProvider);
        check(recovery.get(0).contains("Unknown or unavailable"), "unknown tool returns a real error");
        check("done=true".equals(recovery.get(recovery.size() - 1)), "model can recover from tool error");

        System.out.println(passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }

    private static ByokClient.Response response(int status, String body) {
        return new ByokClient.Response() {
            @Override public int status() { return status; }
            @Override public InputStream body() { return new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)); }
            @Override public void close() { }
        };
    }
}
