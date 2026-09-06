package com.aether.app.core;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * A file the user picked from the device.
 *
 * THE ENGINE HAS NO UPLOAD ENDPOINT. Its routes are /api/* (proxied to Ollama),
 * /files/list and /files/<name> for media it generated itself, and the keyed
 * /off. So an attachment cannot be posted to the engine as a file. What does
 * work, and what this models honestly:
 *
 *   - a copy is kept in app-private storage and referenced from the session, so
 *     history still shows what was attached;
 *   - text-shaped files have their text inlined into the prompt, which is the
 *     only way this model can actually read one;
 *   - anything binary is recorded as attached-but-not-sent, and the UI says so
 *     rather than pretending the model saw it.
 */
public final class Attachment {

    public final String id;
    public final String name;
    public final long size;
    public final String mime;
    /** Extracted text, or null when the file is binary. */
    public final String text;
    /** True when the text above was folded into the prompt sent to the engine. */
    public final boolean sentToEngine;

    public Attachment(String id, String name, long size, String mime,
                      String text, boolean sentToEngine) {
        this.id = id;
        this.name = name == null ? "file" : name;
        this.size = size;
        this.mime = mime == null ? "application/octet-stream" : mime;
        this.text = text;
        this.sentToEngine = sentToEngine;
    }

    public boolean hasText() { return text != null && !text.isEmpty(); }

    public JSONObject toJson() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("id", id);
        o.put("name", name);
        o.put("size", size);
        o.put("mime", mime);
        o.put("sentToEngine", sentToEngine);
        if (text != null) o.put("text", text);
        return o;
    }

    public static Attachment fromJson(JSONObject o) {
        return new Attachment(
                o.optString("id", ""),
                o.optString("name", "file"),
                o.optLong("size", 0),
                o.optString("mime", "application/octet-stream"),
                o.has("text") && !o.isNull("text") ? o.optString("text") : null,
                o.optBoolean("sentToEngine", false));
    }

    static JSONArray arrayToJson(java.util.List<Attachment> list) throws JSONException {
        JSONArray a = new JSONArray();
        if (list != null) for (Attachment at : list) a.put(at.toJson());
        return a;
    }

    static java.util.List<Attachment> arrayFromJson(JSONArray a) {
        java.util.List<Attachment> out = new java.util.ArrayList<>();
        if (a == null) return out;
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o != null) out.add(fromJson(o));
        }
        return out;
    }
}
