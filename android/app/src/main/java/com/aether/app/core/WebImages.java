package com.aether.app.core;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Images the agent FOUND on the web, as opposed to images it generated.
 *
 * WHY THIS IS SEPARATE. A generated image arrives as a structured event from the
 * kernel, so the URL is known to be real. An image found by web_search or
 * fetch_page arrives as prose: a markdown tag, a bare link, sometimes wrapped in
 * an anchor, sometimes half-typed because the stream was cut. Dumping those URLs
 * into the chat is what the user complained about, and blindly rendering them is
 * worse -- an untrusted page can hand us a javascript: URL, a tracking pixel, or
 * a link with credentials baked into the userinfo.
 *
 * So: parse, validate, sanitise, dedupe, and only then hand back items the
 * existing media renderer already knows how to show. Anything that fails the
 * checks is dropped rather than rendered, and the bare URL is taken out of the
 * prose so the answer stays readable either way.
 */
public final class WebImages {

    /** Formats the platform image loader can actually decode. */
    private static final String[] EXTENSIONS =
            {"jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"};

    /** How many inline images one answer may carry before it becomes a gallery. */
    public static final int MAX_PER_MESSAGE = 6;

    private WebImages() { }

    /**
     * Every renderable image URL in the text, in order of appearance, deduped.
     *
     * Handles the markdown form {@code ![alt](url)} -- where the alt text is
     * worth keeping as attribution -- and the bare-link form the model falls
     * back to when it is describing a page.
     */
    public static List<MediaItem> find(String text) {
        List<MediaItem> out = new ArrayList<>();
        if (text == null || text.isEmpty()) return out;
        /* Keys are the sanitised URL, so the same image linked twice in an
           answer does not become two cards. LinkedHashMap keeps first-seen
           order, which is the order the reader met them in. */
        Map<String, MediaItem> seen = new LinkedHashMap<>();

        for (String raw : candidates(text)) {
            String clean = sanitize(raw);
            if (clean == null) continue;
            if (seen.containsKey(clean)) continue;
            if (seen.size() >= MAX_PER_MESSAGE) break;
            /* "web" is the honest source: the engine found this, it did not
               make it. The renderer shows attribution from this. */
            seen.put(clean, new MediaItem(MediaItem.KIND_IMAGE, clean, "web"));
        }
        out.addAll(seen.values());
        return out;
    }

    /**
     * The same text with bare image links removed.
     *
     * Only bare links go: a markdown image keeps its alt text, because that is
     * the description the reader needs now that the URL is a picture instead of
     * a wall of characters.
     */
    public static String strip(String text) {
        if (text == null || text.isEmpty()) return text;
        String out = text;
        /* Markdown first, so the alt text survives in place of the link. */
        out = out.replaceAll("!\\[([^\\]]*)\\]\\(\\s*(https?://[^)\\s]+)\\s*\\)", "$1");
        /* Then any bare link that is actually a renderable image. A URL that
           fails sanitize stays in the prose: better a visible link than a
           silently dropped one the user cannot follow. */
        StringBuilder sb = new StringBuilder();
        int i = 0;
        while (i < out.length()) {
            int start = indexOfUrl(out, i);
            if (start < 0) { sb.append(out, i, out.length()); break; }
            int end = endOfUrl(out, start);
            String url = out.substring(start, end);
            sb.append(out, i, start);
            if (sanitize(url) != null) {
                /* Left as nothing rather than a placeholder: the image itself is
                   rendered right here in the same bubble. */
            } else {
                sb.append(url);
            }
            i = end;
        }
        return sb.toString().replaceAll("[ \\t]{2,}", " ")
                .replaceAll("\\(\\s*\\)", "").trim();
    }

    // ------------------------------------------------------------- internals

    /** Raw URL-ish substrings, from both the markdown and the bare form. */
    private static List<String> candidates(String text) {
        List<String> out = new ArrayList<>();
        java.util.regex.Matcher m =
                java.util.regex.Pattern.compile("!\\[[^\\]]*\\]\\(\\s*(https?://[^)\\s]+)\\s*\\)")
                        .matcher(text);
        while (m.find()) out.add(m.group(1));
        int i = 0;
        while (i < text.length()) {
            int s = indexOfUrl(text, i);
            if (s < 0) break;
            int e = endOfUrl(text, s);
            out.add(text.substring(s, e));
            i = e;
        }
        return out;
    }

    private static int indexOfUrl(String s, int from) {
        int a = s.indexOf("http://", from);
        int b = s.indexOf("https://", from);
        if (a < 0) return b;
        if (b < 0) return a;
        return Math.min(a, b);
    }

    private static int endOfUrl(String s, int start) {
        int e = start;
        while (e < s.length() && !Character.isWhitespace(s.charAt(e))
                && ")]>\"'<".indexOf(s.charAt(e)) < 0) e++;
        /* Trailing punctuation is prose, not part of the link. */
        while (e > start && ".,;:!?".indexOf(s.charAt(e - 1)) >= 0) e--;
        return e;
    }

    /**
     * The URL if it is safe and renderable, otherwise null.
     *
     * @return a normalised https/http URL, or null when it must not be rendered
     */
    static String sanitize(String raw) {
        if (raw == null) return null;
        String u = raw.trim();
        if (u.isEmpty()) return null;

        /* Entities the model copies straight out of fetched HTML. */
        u = u.replace("&amp;", "&");

        String lower = u.toLowerCase(Locale.ROOT);
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) return null;
        /* A credential in the userinfo would be sent to a host the user never
           chose, and would leak into any log that recorded the URL. */
        if (u.substring(lower.startsWith("https://") ? 8 : 7).contains("@")) return null;

        String path = u;
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        int hash = path.indexOf('#');
        if (hash >= 0) path = path.substring(0, hash);
        int slash = path.lastIndexOf('/');
        String file = slash >= 0 ? path.substring(slash + 1) : "";
        int dot = file.lastIndexOf('.');
        if (dot < 0 || dot == file.length() - 1) return null;
        String ext = file.substring(dot + 1).toLowerCase(Locale.ROOT);
        for (String ok : EXTENSIONS) if (ok.equals(ext)) return u;
        return null;
    }
}
