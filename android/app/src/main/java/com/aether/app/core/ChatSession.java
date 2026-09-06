package com.aether.app.core;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * One saved conversation: an id, a title the user can change, timestamps, and
 * the messages.
 *
 * Title policy: it is derived from the first real prompt so a fresh chat is
 * recognisable in the drawer, and after that it belongs to the user -- renaming
 * sets a flag so a later turn never overwrites a title they chose.
 */
public final class ChatSession {

    public String id;
    public String title;
    public long createdAt;
    public long updatedAt;
    /** Engine slot used for the most recent assistant turn, when known. */
    public String engine;
    /** Set once the user names the chat, so streaming never renames it back. */
    public boolean titleLocked;
    public final List<ChatMessage> messages;

    public ChatSession(String id, String title) {
        this.id = id;
        this.title = title;
        this.createdAt = System.currentTimeMillis();
        this.updatedAt = this.createdAt;
        this.messages = new ArrayList<>();
    }

    public void touch() { this.updatedAt = System.currentTimeMillis(); }

    public void rename(String newTitle) {
        String t = newTitle == null ? "" : newTitle.trim();
        this.title = t.isEmpty() ? "Untitled chat" : t;
        this.titleLocked = true;
        touch();
    }

    public int messageCount() { return messages.size(); }

    /** The last thing the user asked -- what "retry" re-sends. */
    public String lastUserPrompt() {
        for (int i = messages.size() - 1; i >= 0; i--) {
            ChatMessage m = messages.get(i);
            if (m.isUser() && m.content != null && !m.content.isEmpty()) return m.content;
        }
        return null;
    }

    /** The user prompt immediately before the message at index i. */
    public String userPromptBefore(int index) {
        for (int i = Math.min(index, messages.size() - 1); i >= 0; i--) {
            ChatMessage m = messages.get(i);
            if (m.isUser() && m.content != null && !m.content.isEmpty()) return m.content;
        }
        return null;
    }

    /** First line of the newest message, for the drawer subtitle. */
    public String preview() {
        for (int i = messages.size() - 1; i >= 0; i--) {
            ChatMessage m = messages.get(i);
            String c = m.content == null ? "" : m.content.trim();
            if (c.isEmpty()) continue;
            int nl = c.indexOf('\n');
            if (nl > 0) c = c.substring(0, nl);
            c = c.replaceAll("\\s+", " ").trim();
            if (c.isEmpty()) continue;
            return c.length() > 90 ? c.substring(0, 89) + "…" : c;
        }
        return "";
    }

    public JSONObject toJson() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("v", 1);
        o.put("id", id);
        o.put("title", title == null ? "New chat" : title);
        o.put("createdAt", createdAt);
        o.put("updatedAt", updatedAt);
        o.put("titleLocked", titleLocked);
        if (engine != null && !engine.isEmpty()) o.put("engine", engine);
        JSONArray a = new JSONArray();
        for (ChatMessage m : messages) a.put(m.toJson());
        o.put("messages", a);
        return o;
    }

    public static ChatSession fromJson(JSONObject o) throws JSONException {
        ChatSession s = new ChatSession(o.optString("id", ""), o.optString("title", "New chat"));
        s.createdAt = o.optLong("createdAt", s.createdAt);
        s.updatedAt = o.optLong("updatedAt", s.updatedAt);
        s.titleLocked = o.optBoolean("titleLocked", false);
        s.engine = o.has("engine") && !o.isNull("engine") ? o.optString("engine") : null;
        s.messages.clear();
        JSONArray a = o.optJSONArray("messages");
        if (a != null) {
            for (int i = 0; i < a.length(); i++) {
                JSONObject mo = a.optJSONObject(i);
                if (mo != null) s.messages.add(ChatMessage.fromJson(mo));
            }
        }
        return s;
    }
}
