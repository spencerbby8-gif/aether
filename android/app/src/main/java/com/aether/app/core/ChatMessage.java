package com.aether.app.core;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * One turn in a chat, in the three zones the engine actually streams:
 * thinking, tool activity, and content.
 *
 * Nothing here is invented by the client: `thinking` and `toolLines` are only
 * ever populated from real NDJSON events, so a saved transcript shows what the
 * engine really did rather than a decorative record of it.
 */
public final class ChatMessage {

    public static final String ROLE_USER = "user";
    public static final String ROLE_ASSISTANT = "assistant";

    /** How the turn ended. Only these three, so history cannot lie about it. */
    public static final String STATUS_OK = "ok";
    public static final String STATUS_STOPPED = "stopped";
    public static final String STATUS_ERROR = "error";

    public String role;
    public String content;
    public String thinking;
    public final List<String> toolLines;
    public long ts;
    public String status;
    /** Non-fatal detail, e.g. why a turn errored. */
    public String note;
    /** Engine slot that produced an assistant turn, when known. */
    public String engine;
    public List<Attachment> attachments;

    /** Images and voice clips the engine generated during this turn. */
    public List<MediaItem> media;

    /**
     * What this turn's task ended up being: done, failed or cancelled, with the
     * evidence. Kept with the message so a user who comes back later can see
     * what actually happened rather than guessing from a half answer.
     */
    public String taskReport;

    public ChatMessage(String role) {
        this.role = role;
        this.content = "";
        this.thinking = "";
        this.toolLines = new ArrayList<>();
        this.ts = System.currentTimeMillis();
        this.status = STATUS_OK;
        this.attachments = new ArrayList<>();
    }

    public boolean isUser() { return ROLE_USER.equals(role); }

    /** True when there is nothing to show for this turn yet. */
    public boolean isEmpty() {
        return (content == null || content.isEmpty())
                && (thinking == null || thinking.isEmpty())
                && toolLines.isEmpty();
    }

    public JSONObject toJson() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("role", role);
        o.put("content", content == null ? "" : content);
        if (thinking != null && !thinking.isEmpty()) o.put("thinking", thinking);
        if (!toolLines.isEmpty()) {
            JSONArray a = new JSONArray();
            for (String t : toolLines) a.put(t);
            o.put("tools", a);
        }
        o.put("ts", ts);
        o.put("status", status == null ? STATUS_OK : status);
        if (note != null && !note.isEmpty()) o.put("note", note);
        if (taskReport != null && !taskReport.isEmpty()) o.put("taskReport", taskReport);
        if (engine != null && !engine.isEmpty()) o.put("engine", engine);
        if (attachments != null && !attachments.isEmpty()) {
            o.put("attachments", Attachment.arrayToJson(attachments));
        }
        if (media != null && !media.isEmpty()) {
            o.put("media", MediaItem.arrayToJson(media));
        }
        return o;
    }

    public static ChatMessage fromJson(JSONObject o) {
        ChatMessage m = new ChatMessage(o.optString("role", ROLE_USER));
        m.content = o.optString("content", "");
        m.thinking = o.optString("thinking", "");
        m.ts = o.optLong("ts", 0);
        m.status = o.optString("status", STATUS_OK);
        m.note = o.has("note") && !o.isNull("note") ? o.optString("note") : null;
        m.taskReport = o.has("taskReport") && !o.isNull("taskReport")
                ? o.optString("taskReport") : null;
        m.engine = o.has("engine") && !o.isNull("engine") ? o.optString("engine") : null;
        m.toolLines.clear();
        JSONArray tools = o.optJSONArray("tools");
        if (tools != null) {
            for (int i = 0; i < tools.length(); i++) {
                String t = tools.optString(i, "");
                if (!t.isEmpty()) m.toolLines.add(t);
            }
        }
        m.attachments = Attachment.arrayFromJson(o.optJSONArray("attachments"));
        m.media = MediaItem.arrayFromJson(o.optJSONArray("media"));
        return m;
    }
}
