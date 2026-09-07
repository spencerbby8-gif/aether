package com.aether.app.core;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Something the engine generated for the user -- an image or a voice clip.
 *
 * These are reported by the kernel as a structured event rather than scraped
 * out of the model's prose, because the model may reword, shorten or drop the
 * URL entirely. The item is persisted with the message so a generated file is
 * still there after the app is closed, and the download is recorded so the same
 * file is not fetched twice.
 */
public final class MediaItem {

    public static final String KIND_IMAGE = "image";
    public static final String KIND_AUDIO = "audio";

    public final String kind;
    public final String url;
    /** Tool that produced it, e.g. "generate_image". */
    public final String source;
    /** Set once the user has saved it, so the row can say where it went. */
    public String savedName;

    public MediaItem(String kind, String url, String source) {
        this.kind = kind == null ? KIND_IMAGE : kind;
        this.url = url == null ? "" : url;
        this.source = source == null ? "" : source;
    }

    public boolean isImage() { return KIND_IMAGE.equals(kind); }

    public boolean isAudio() { return KIND_AUDIO.equals(kind); }

    /** A file name for saving, derived from the URL when the engine gave one. */
    public String suggestedName() {
        String base = url;
        int q = base.indexOf('?');
        if (q >= 0) base = base.substring(0, q);
        int slash = base.lastIndexOf('/');
        if (slash >= 0 && slash < base.length() - 1) base = base.substring(slash + 1);
        base = base.replaceAll("[^A-Za-z0-9._-]", "_");
        if (base.isEmpty()) base = isAudio() ? "aether-voice.wav" : "aether-image.jpg";
        if (!base.contains(".")) base += isAudio() ? ".wav" : ".jpg";
        return base;
    }

    public boolean isValid() {
        return url.startsWith("http://") || url.startsWith("https://");
    }

    public JSONObject toJson() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("kind", kind);
        o.put("url", url);
        o.put("source", source);
        if (savedName != null && !savedName.isEmpty()) o.put("saved", savedName);
        return o;
    }

    public static MediaItem fromJson(JSONObject o) {
        if (o == null) return null;
        MediaItem m = new MediaItem(o.optString("kind", KIND_IMAGE),
                o.optString("url", ""), o.optString("source", ""));
        m.savedName = o.has("saved") && !o.isNull("saved") ? o.optString("saved") : null;
        return m;
    }

    public static JSONArray arrayToJson(List<MediaItem> items) throws JSONException {
        JSONArray a = new JSONArray();
        if (items != null) for (MediaItem m : items) if (m != null) a.put(m.toJson());
        return a;
    }

    public static List<MediaItem> arrayFromJson(JSONArray a) {
        List<MediaItem> out = new ArrayList<>();
        if (a == null) return out;
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o == null) continue;
            MediaItem m = fromJson(o);
            /* A media row with no usable URL is worse than none: it would show
               a card that can never load or save. */
            if (m != null && m.isValid()) out.add(m);
        }
        return out;
    }
}
