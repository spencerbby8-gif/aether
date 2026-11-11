package com.aether.app;

import com.aether.app.core.AgentActivity;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Real, bounded tools available without Kaggle.
 *
 * Commands are direct /system/bin processes in an app-private workspace. There
 * is no shell, pipeline, redirection, arbitrary executable, or path escape.
 * Remote MCP tools require an explicit per-call approval in addition to the
 * connector grants, because server annotations and descriptions are untrusted.
 */
public final class LocalToolRegistry implements ByokAgent.Tools {
    public interface Approver {
        boolean approve(String action, String detail) throws Exception;
    }

    public static final class ConnectorGrant {
        public String name = "";
        public String url = "";
        public String token = "";
        public boolean read = true;
        public boolean write;
        public boolean execute;
    }

    private static final int MAX_FILE_BYTES = 2 * 1024 * 1024;
    private static final int MAX_WEB_BYTES = 1024 * 1024;
    private static final int MAX_COMMAND_BYTES = 256 * 1024;
    private static final int COMMAND_TIMEOUT_SECONDS = 30;

    private final File root;
    private final List<ConnectorGrant> connectors;
    private final Approver approver;
    private final Map<String, McpBinding> mcpTools = new HashMap<>();
    private final List<String> warnings = new ArrayList<>();

    public LocalToolRegistry(File workspace, List<ConnectorGrant> connectors, Approver approver) {
        try {
            this.root = workspace.getCanonicalFile();
            if (!root.exists() && !root.mkdirs()) throw new Exception("Could not create the Agent workspace.");
        } catch (Exception e) {
            throw new IllegalArgumentException("Invalid Agent workspace", e);
        }
        this.connectors = connectors == null ? new ArrayList<ConnectorGrant>() : connectors;
        this.approver = approver;
    }

    public File workspace() { return root; }
    public List<String> warnings() { return new ArrayList<>(warnings); }

    @Override public JSONArray schemas() throws Exception {
        JSONArray out = new JSONArray();
        out.put(schema("run_command", "Run a real allowlisted Android command in this chat's private workspace. No shell syntax, pipes, redirection, network CLIs, or arbitrary executables. Prefer file tools for simple edits.",
                object().put("command", string("Command and arguments. Allowed: pwd, ls, cat, echo, stat, wc, head, tail, grep, find; writes: mkdir, touch, cp, mv, rm (approval required).")), "command"));
        out.put(schema("list_files", "List files and directories inside the Agent workspace.",
                object().put("path", string("Workspace-relative directory; default ."))));
        out.put(schema("read_file", "Read a UTF-8 text file from the Agent workspace (maximum 2 MB).",
                object().put("path", string("Workspace-relative file path")), "path"));
        out.put(schema("write_file", "Create or replace a UTF-8 text file in the Agent workspace. Requires user approval.",
                object().put("path", string("Workspace-relative file path")).put("content", string("Complete file content")), "path", "content"));
        out.put(schema("delete_file", "Delete a file or empty directory in the Agent workspace. Requires user approval.",
                object().put("path", string("Workspace-relative path")), "path"));
        out.put(schema("fetch_page", "Fetch a public HTTPS page, strip markup, and return readable text. Local/private addresses are blocked.",
                object().put("url", string("Public HTTPS URL")), "url"));
        out.put(schema("web_search", "Search the public web and return result titles, URLs, and snippets.",
                object().put("query", string("Search query")), "query"));
        out.put(schema("current_time", "Get the current UTC and local device time.", object()));

        mcpTools.clear();
        warnings.clear();
        int index = 0;
        for (ConnectorGrant grant : connectors) {
            index++;
            try {
                McpClient.Config config = new McpClient.Config();
                config.name = grant.name; config.url = grant.url; config.token = grant.token;
                McpClient client = new McpClient(config);
                for (McpClient.Tool tool : client.listTools()) {
                    String local = "mcp_" + index + "_" + safeName(tool.name);
                    if (local.length() > 64) local = local.substring(0, 64);
                    if (mcpTools.containsKey(local)) continue;
                    McpBinding binding = new McpBinding();
                    binding.client = client; binding.remoteName = tool.name; binding.connector = grant.name; binding.grant = grant;
                    mcpTools.put(local, binding);
                    out.put(schema(local, "Connector " + grant.name + ": " + AgentActivity.clip(tool.description, 500)
                            + " Every call requires user approval.", tool.inputSchema, (String[]) null));
                }
            } catch (Exception e) {
                warnings.add(grant.name + " could not be opened: " + safe(e));
            }
        }
        return out;
    }

    @Override public ByokAgent.Result execute(String name, JSONObject args,
                                               ByokAgent.Output output, boolean[] cancelled) throws Exception {
        switch (name) {
            case "run_command": return command(args.optString("command", ""), output, cancelled);
            case "list_files": return listFiles(args.optString("path", "."));
            case "read_file": return readFile(args.optString("path", ""));
            case "write_file": return writeFile(args.optString("path", ""), args.optString("content", ""));
            case "delete_file": return deleteFile(args.optString("path", ""));
            case "fetch_page": return fetchPage(args.optString("url", ""));
            case "web_search": return search(args.optString("query", ""));
            case "current_time": return currentTime();
            default:
                McpBinding binding = mcpTools.get(name);
                if (binding == null) return ByokAgent.Result.error("Unknown or unavailable tool: " + name);
                String permission = connectorPermission(binding.remoteName);
                boolean granted = "read".equals(permission) ? binding.grant.read
                        : "execute".equals(permission) ? binding.grant.execute : binding.grant.write;
                if (!granted) return ByokAgent.Result.error("Connector " + binding.connector + " has not granted " + permission
                        + " permission for " + binding.remoteName + ". Nothing was sent.");
                if (!approve("Allow connector " + permission + " action?", binding.connector + " · " + binding.remoteName
                        + "\n\nReview the arguments in the activity banner. Server-provided descriptions are not a safety guarantee.")) {
                    return ByokAgent.Result.error("User denied this connector action. Nothing was sent.");
                }
                output.write("Calling " + binding.connector + " · " + binding.remoteName + "\n");
                McpClient.CallResult result = binding.client.call(binding.remoteName, args);
                output.write(result.text + "\n");
                return new ByokAgent.Result(result.text, !result.isError, result.isError ? 1 : 0);
        }
    }

    private ByokAgent.Result command(String command, ByokAgent.Output output, boolean[] cancelled) throws Exception {
        List<String> argv = split(command);
        if (argv.isEmpty()) return ByokAgent.Result.error("A command is required.");
        String name = argv.get(0);
        String allowed = "pwd ls cat echo stat wc head tail grep find mkdir touch cp mv rm";
        if (!(" " + allowed + " ").contains(" " + name + " ")) {
            return ByokAgent.Result.error("Command is not allowlisted: " + name + ". No process was started.");
        }
        boolean write = "mkdir touch cp mv rm".contains(name);
        if (write && !approve("Allow workspace command?", command + "\n\nThis can create, change, move, or delete files inside this chat's workspace only.")) {
            return ByokAgent.Result.error("User denied the command. No process was started.");
        }
        if (cancelled != null && cancelled[0]) return ByokAgent.Result.error("Command cancelled before startup.");
        validateArguments(name, argv);
        if ("pwd".equals(name)) {
            String value = root.getAbsolutePath() + "\n";
            output.write(value);
            return ByokAgent.Result.ok(value);
        }

        String androidExecutable = "/system/bin/" + name;
        // JVM proofs run the same class on Linux, where Android's /system/bin
        // does not exist. Android itself always takes the first branch.
        if (new File(androidExecutable).isFile()) argv.set(0, androidExecutable);
        else if (new File("/bin/" + name).isFile()) argv.set(0, "/bin/" + name);
        else if (new File("/usr/bin/" + name).isFile()) argv.set(0, "/usr/bin/" + name);
        else argv.set(0, name);
        ProcessBuilder builder = new ProcessBuilder(argv);
        builder.directory(root);
        builder.redirectErrorStream(true);
        Map<String, String> environment = builder.environment();
        environment.clear();
        environment.put("PATH", "/system/bin:/system/xbin");
        environment.put("HOME", root.getAbsolutePath());
        environment.put("TMPDIR", root.getAbsolutePath());
        output.write("$ " + command + "\n");
        Process process = builder.start();
        StringBuilder captured = new StringBuilder();
        try {
            InputStream in = process.getInputStream();
            byte[] buffer = new byte[2048];
            long deadline = System.currentTimeMillis() + COMMAND_TIMEOUT_SECONDS * 1000L;
            boolean truncated = false;
            while (true) {
                while (in.available() > 0) {
                    int n = in.read(buffer, 0, Math.min(buffer.length, in.available()));
                    if (n <= 0) break;
                    String chunk = new String(buffer, 0, n, StandardCharsets.UTF_8);
                    if (captured.length() < MAX_COMMAND_BYTES) {
                        captured.append(chunk);
                        if (captured.length() > MAX_COMMAND_BYTES) captured.setLength(MAX_COMMAND_BYTES);
                    } else truncated = true;
                    output.write(chunk);
                }
                if (cancelled != null && cancelled[0]) {
                    process.destroy();
                    return ByokAgent.Result.error(captured + "\nCommand cancelled by user.");
                }
                if (System.currentTimeMillis() > deadline) {
                    process.destroy();
                    return ByokAgent.Result.error(captured + "\nCommand timed out after " + COMMAND_TIMEOUT_SECONDS + " seconds.");
                }
                try {
                    int exit = process.exitValue();
                    int n;
                    while ((n = in.read(buffer)) >= 0) {
                        String chunk = new String(buffer, 0, n, StandardCharsets.UTF_8);
                        output.write(chunk);
                        if (captured.length() < MAX_COMMAND_BYTES) captured.append(chunk);
                    }
                    if (truncated) captured.append("\n[output truncated]");
                    captured.append("\n[exit ").append(exit).append(']');
                    return new ByokAgent.Result(captured.toString(), exit == 0, exit);
                } catch (IllegalThreadStateException running) {
                    Thread.sleep(35);
                }
            }
        } finally {
            process.destroy();
        }
    }

    private void validateArguments(String command, List<String> argv) throws Exception {
        if (argv.size() > 128 || command.length() > 16_000) throw new Exception("Command is too large.");
        if ("find".equals(command)) {
            for (String arg : argv) if ("-exec".equals(arg) || "-execdir".equals(arg) || "-delete".equals(arg)
                    || "-ok".equals(arg) || "-okdir".equals(arg)) throw new Exception("find execution/deletion expressions are not allowed.");
        }
        if ("grep".equals(command)) {
            for (int i = 1; i < argv.size(); i++) {
                String arg = argv.get(i);
                if (arg.startsWith("-") && !arg.matches("-[invrRlwcEF]+")) {
                    throw new Exception("Only simple grep flags are allowed; pattern-file and command options are blocked.");
                }
            }
        }
        if ("echo".equals(command) || "pwd".equals(command)) return;
        List<String> paths = new ArrayList<>();
        boolean patternSeen = false;
        for (int i = 1; i < argv.size(); i++) {
            String arg = argv.get(i);
            if (arg.startsWith("-") || arg.matches("[0-9]+")) continue;
            if ("grep".equals(command) && !patternSeen) { patternSeen = true; continue; }
            if ("find".equals(command) && i > 1 && argv.get(i - 1).startsWith("-")) continue;
            paths.add(arg);
        }
        for (String path : paths) resolve(path);
    }

    private ByokAgent.Result listFiles(String path) throws Exception {
        File file = resolve(path.isEmpty() ? "." : path);
        if (!file.exists()) return ByokAgent.Result.error("Path does not exist: " + path);
        JSONArray out = new JSONArray();
        if (file.isFile()) {
            out.put(fileJson(file));
        } else {
            File[] children = file.listFiles();
            if (children == null) return ByokAgent.Result.error("Directory could not be listed.");
            java.util.Arrays.sort(children, (a, b) -> a.getName().compareToIgnoreCase(b.getName()));
            int count = 0;
            for (File child : children) {
                if (++count > 500) break;
                out.put(fileJson(child));
            }
        }
        return ByokAgent.Result.ok(out.toString(2));
    }

    private JSONObject fileJson(File file) throws Exception {
        return new JSONObject().put("name", file.getName()).put("path", relative(file))
                .put("directory", file.isDirectory()).put("bytes", file.isFile() ? file.length() : 0);
    }

    private ByokAgent.Result readFile(String path) throws Exception {
        File file = resolve(path);
        if (!file.isFile()) return ByokAgent.Result.error("Not a readable workspace file: " + path);
        if (file.length() > MAX_FILE_BYTES) return ByokAgent.Result.error("File exceeds the 2 MB read limit.");
        String value = new String(readAll(new FileInputStream(file), MAX_FILE_BYTES), StandardCharsets.UTF_8);
        return ByokAgent.Result.ok(value);
    }

    private ByokAgent.Result writeFile(String path, String content) throws Exception {
        File file = resolve(path);
        if (!approve("Allow file write?", path + "\n\n" + content.length() + " characters will be written inside this chat's workspace.")) {
            return ByokAgent.Result.error("User denied the file write.");
        }
        if (content.getBytes(StandardCharsets.UTF_8).length > MAX_FILE_BYTES) return ByokAgent.Result.error("Content exceeds the 2 MB write limit.");
        File parent = file.getParentFile();
        if (parent == null || (!parent.exists() && !parent.mkdirs())) return ByokAgent.Result.error("Could not create the parent directory.");
        resolve(parent.getPath());
        try (FileOutputStream out = new FileOutputStream(file, false)) {
            out.write(content.getBytes(StandardCharsets.UTF_8));
        }
        return ByokAgent.Result.ok("Wrote " + content.getBytes(StandardCharsets.UTF_8).length + " bytes to " + relative(file));
    }

    private ByokAgent.Result deleteFile(String path) throws Exception {
        File file = resolve(path);
        if (file.equals(root)) return ByokAgent.Result.error("The workspace root cannot be deleted.");
        if (!file.exists()) return ByokAgent.Result.error("Path does not exist: " + path);
        if (!approve("Allow deletion?", path + "\n\nThis permanently removes the file or empty directory.")) {
            return ByokAgent.Result.error("User denied deletion.");
        }
        if (!file.delete()) return ByokAgent.Result.error("Could not delete. Directories must be empty.");
        return ByokAgent.Result.ok("Deleted " + path);
    }

    private ByokAgent.Result fetchPage(String raw) throws Exception {
        String body = httpText(raw, 0);
        String contentType = "";
        String readable = htmlToText(body);
        if (readable.isEmpty()) return ByokAgent.Result.error("The page returned no readable text.");
        return ByokAgent.Result.ok(AgentActivity.clip(readable, 120_000));
    }

    private ByokAgent.Result search(String query) throws Exception {
        if (query.trim().isEmpty()) return ByokAgent.Result.error("A search query is required.");
        String url = "https://html.duckduckgo.com/html/?q=" + URLEncoder.encode(query.trim(), "UTF-8");
        String html = httpText(url, 0);
        JSONArray results = new JSONArray();
        Matcher matcher = Pattern.compile("<a[^>]*class=\\\"result__a\\\"[^>]*href=\\\"([^\\\"]+)\\\"[^>]*>(.*?)</a>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL).matcher(html);
        while (matcher.find() && results.length() < 8) {
            String link = htmlDecode(matcher.group(1));
            String title = htmlToText(matcher.group(2));
            if (link.contains("uddg=")) {
                String encoded = link.replaceFirst(".*[?&]uddg=", "").replaceFirst("&.*$", "");
                link = URLDecoder.decode(encoded, "UTF-8");
            }
            results.put(new JSONObject().put("title", title).put("url", link));
        }
        if (results.length() == 0) return ByokAgent.Result.error("No parseable results returned. Try fetch_page with a direct source URL.");
        return ByokAgent.Result.ok(results.toString(2));
    }

    private ByokAgent.Result currentTime() throws Exception {
        SimpleDateFormat utc = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        utc.setTimeZone(TimeZone.getTimeZone("UTC"));
        return ByokAgent.Result.ok(new JSONObject().put("utc", utc.format(new Date()))
                .put("device_local", new Date().toString()).put("timezone", TimeZone.getDefault().getID()).toString(2));
    }

    private String httpText(String raw, int redirects) throws Exception {
        if (redirects > 3) throw new Exception("Too many redirects.");
        URL url = new URL(raw);
        if (!"https".equalsIgnoreCase(url.getProtocol())) throw new Exception("Only public HTTPS URLs are allowed.");
        if (url.getUserInfo() != null) throw new Exception("Credentials are not allowed in URLs.");
        for (InetAddress address : InetAddress.getAllByName(url.getHost())) {
            if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress()
                    || address.isSiteLocalAddress() || address.isMulticastAddress()) throw new Exception("Private and local addresses are blocked.");
        }
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        try {
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(12_000); c.setReadTimeout(25_000);
            c.setRequestProperty("User-Agent", "AetherAndroid/3.2 (+user-initiated agent research)");
            c.setRequestProperty("Accept", "text/html,application/json,text/plain,application/xml;q=0.9,*/*;q=0.1");
            int status = c.getResponseCode();
            if (status >= 300 && status < 400) {
                String location = c.getHeaderField("Location");
                if (location == null) throw new Exception("Redirect had no destination.");
                return httpText(new URL(url, location).toString(), redirects + 1);
            }
            if (status < 200 || status >= 300) throw new Exception("Web request failed (HTTP " + status + ").");
            String type = c.getContentType() == null ? "" : c.getContentType().toLowerCase(Locale.ROOT);
            if (type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("video/") || type.contains("octet-stream")) {
                throw new Exception("This tool reads text, not binary media.");
            }
            return new String(readAll(c.getInputStream(), MAX_WEB_BYTES), StandardCharsets.UTF_8);
        } finally { c.disconnect(); }
    }

    private static String connectorPermission(String remoteName) {
        String value = remoteName == null ? "" : remoteName.toLowerCase(Locale.ROOT);
        if (value.matches(".*(^|_)(run|execute|exec|workflow|deploy|trigger|dispatch|command)(_|$).*")) return "execute";
        if (value.matches(".*(^|_)(get|list|read|search|fetch|query|find|download|retrieve|inspect|status)(_|$).*")) return "read";
        // Unknown operations default to write, never to the weakest grant.
        return "write";
    }

    private boolean approve(String action, String detail) throws Exception {
        if (approver == null) return false;
        return approver.approve(action, detail);
    }

    private File resolve(String path) throws Exception {
        if (path == null || path.trim().isEmpty() || path.indexOf('\0') >= 0) throw new Exception("A workspace path is required.");
        File candidate = new File(path);
        File file = candidate.isAbsolute() ? candidate : new File(root, path);
        file = file.getCanonicalFile();
        String prefix = root.getPath() + File.separator;
        if (!file.equals(root) && !file.getPath().startsWith(prefix)) throw new Exception("Path escapes the Agent workspace: " + path);
        return file;
    }

    private String relative(File file) throws Exception {
        String path = file.getCanonicalPath();
        return path.equals(root.getPath()) ? "." : path.substring(root.getPath().length() + 1);
    }

    private static List<String> split(String command) throws Exception {
        List<String> out = new ArrayList<>();
        StringBuilder token = new StringBuilder();
        char quote = 0;
        boolean escaped = false;
        for (char c : command.toCharArray()) {
            if (escaped) { token.append(c); escaped = false; continue; }
            if (c == '\\') { escaped = true; continue; }
            if (quote != 0) {
                if (c == quote) quote = 0; else token.append(c);
                continue;
            }
            if (c == '\'' || c == '"') { quote = c; continue; }
            if (Character.isWhitespace(c)) {
                if (token.length() > 0) { out.add(token.toString()); token.setLength(0); }
            } else token.append(c);
        }
        if (escaped || quote != 0) throw new Exception("Unclosed quote or escape in command.");
        if (token.length() > 0) out.add(token.toString());
        return out;
    }

    private static byte[] readAll(InputStream in, int max) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int n;
        while ((n = in.read(buffer)) >= 0) {
            if (out.size() + n > max) throw new Exception("Response exceeds the size limit.");
            out.write(buffer, 0, n);
        }
        return out.toByteArray();
    }

    private static String htmlToText(String html) {
        if (html == null) return "";
        String value = html.replaceAll("(?is)<(script|style|noscript|svg).*?</\\1>", " ")
                .replaceAll("(?i)<br\\s*/?>", "\n").replaceAll("(?i)</(p|div|li|h[1-6]|tr)>", "\n")
                .replaceAll("<[^>]+>", " ");
        return htmlDecode(value).replaceAll("[ \\t\\x0B\\f\\r]+", " ")
                .replaceAll(" *\\n *", "\n").replaceAll("\\n{3,}", "\n\n").trim();
    }

    private static String htmlDecode(String value) {
        return value.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
                .replace("&quot;", "\"").replace("&#39;", "'").replace("&nbsp;", " ")
                .replaceAll("&#([0-9]+);", "");
    }

    private static JSONObject object() throws Exception { return new JSONObject().put("type", "object").put("properties", new JSONObject()); }
    private static JSONObject string(String description) throws Exception { return new JSONObject().put("type", "string").put("description", description); }

    private static JSONObject schema(String name, String description, JSONObject input, String... required) {
        try {
            JSONObject properties = input.optJSONObject("properties");
            if (properties == null) input.put("properties", new JSONObject());
            input.put("additionalProperties", false);
            JSONArray req = new JSONArray();
            if (required != null) for (String item : required) req.put(item);
            input.put("required", req);
            JSONObject function = new JSONObject().put("name", name).put("description", description).put("parameters", input);
            return new JSONObject().put("type", "function").put("function", function);
        } catch (Exception e) { return new JSONObject(); }
    }

    private static String safeName(String value) {
        String clean = value == null ? "tool" : value.replaceAll("[^A-Za-z0-9_-]", "_");
        return clean.isEmpty() ? "tool" : clean;
    }

    private static String safe(Exception e) {
        String message = e.getMessage();
        return message == null || message.trim().isEmpty() ? e.getClass().getSimpleName() : message;
    }

    private static final class McpBinding {
        McpClient client;
        String remoteName;
        String connector;
        ConnectorGrant grant;
    }
}
