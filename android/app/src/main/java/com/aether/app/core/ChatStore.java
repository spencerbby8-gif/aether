package com.aether.app.core;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Chat history on the phone.
 *
 * WHERE IT LIVES. One directory in app-private storage
 * (Context.getFilesDir()/chats) -- no storage permission, no cloud, nothing
 * leaves the device. One JSON file per conversation plus a light index.json so
 * the drawer can list every chat without reading every transcript.
 *
 * WHY JSON FILES AND NOT SQLite. Same shape as the web app's IndexedDB stores
 * (conversations + messages, one record per conversation), inspectable on a
 * rooted device or via adb, and -- the part that matters here -- pure Java, so
 * scripts/proofs/ChatCoreCheck.java exercises the real class on the JVM instead
 * of trusting an implementation nobody has run.
 *
 * DURABILITY. Writes go to <id>.json.tmp and are renamed over the target, so an
 * interrupted write cannot leave a half-written transcript where a good one
 * was. A file that fails to parse is skipped, not fatal: one corrupt chat must
 * not take the whole history with it.
 */
public final class ChatStore {

    /** Ids come from JSON on disk, so they are validated before becoming a path. */
    private static final Pattern SAFE_ID = Pattern.compile("[a-z0-9]{6,64}");
    private static final int TITLE_MAX = 42;

    private final File dir;
    private final File indexFile;

    public ChatStore(File dir) {
        this.dir = dir;
        if (!dir.exists()) dir.mkdirs();
        this.indexFile = new File(dir, "index.json");
    }

    /** Directory for copies of picked files, beside the transcripts. */
    public File attachmentDir() {
        File f = new File(dir.getParentFile(), "attachments");
        if (!f.exists()) f.mkdirs();
        return f;
    }

    public File dir() { return dir; }

    /** One drawer row. */
    public static final class Meta {
        public final String id;
        public final String title;
        public final long updatedAt;
        public final int messageCount;
        public final String engine;

        Meta(String id, String title, long updatedAt, int messageCount, String engine) {
            this.id = id;
            this.title = title;
            this.updatedAt = updatedAt;
            this.messageCount = messageCount;
            this.engine = engine;
        }
    }

    // ---------------------------------------------------------------- ids

    public static String newId() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 16);
    }

    public static boolean isSafeId(String id) {
        return id != null && SAFE_ID.matcher(id).matches();
    }

    private File file(String id) {
        if (!isSafeId(id)) throw new IllegalArgumentException("unsafe chat id: " + id);
        return new File(dir, id + ".json");
    }

    // ------------------------------------------------------------- create

    /**
     * A new conversation titled from the prompt that opens it. The title is not
     * locked, so it can still be refined; renaming locks it.
     */
    public synchronized ChatSession create(String firstPrompt) {
        ChatSession s = new ChatSession(newId(), TextNormalizer.title(firstPrompt, TITLE_MAX));
        save(s);
        return s;
    }

    // --------------------------------------------------------------- read

    public synchronized ChatSession load(String id) {
        if (!isSafeId(id)) return null;
        File f = file(id);
        if (!f.isFile()) return null;
        try {
            String json = read(f);
            return ChatSession.fromJson(new JSONObject(json));
        } catch (Exception e) {
            return null;
        }
    }

    /** Every chat, newest first. Rebuilds the index if it is missing or stale. */
    public synchronized List<Meta> list() {
        List<Meta> metas = readIndex();
        if (metas == null) metas = rebuildIndex();
        Collections.sort(metas, new Comparator<Meta>() {
            @Override public int compare(Meta a, Meta b) {
                return Long.compare(b.updatedAt, a.updatedAt);
            }
        });
        return metas;
    }

    public synchronized boolean exists(String id) {
        return isSafeId(id) && file(id).isFile();
    }

    /** How many transcripts are on disk, including any the index does not know. */
    public synchronized int countFiles() {
        String[] names = dir.list();
        int n = 0;
        if (names != null) {
            for (String s : names) if (s.endsWith(".json") && !s.equals("index.json")) n++;
        }
        return n;
    }

    // -------------------------------------------------------------- write

    /** Persist a conversation, atomically, and refresh the index entry. */
    public synchronized void save(ChatSession s) {
        if (s == null || !isSafeId(s.id)) return;
        s.touch();
        try {
            writeAtomic(file(s.id), s.toJson().toString());
        } catch (Exception e) {
            return;
        }
        upsertIndex(metaOf(s));
    }

    /**
     * Rename a chat. Loads, renames, saves, so the file and the index cannot
     * disagree. Returns false when the chat is not on disk.
     */
    public synchronized boolean rename(String id, String title) {
        ChatSession s = load(id);
        if (s == null) return false;
        s.rename(title);
        try {
            writeAtomic(file(id), s.toJson().toString());
        } catch (Exception e) {
            return false;
        }
        upsertIndex(metaOf(s));
        return true;
    }

    /** Delete a chat and its attachments. Returns false when nothing was there. */
    public synchronized boolean delete(String id) {
        if (!isSafeId(id)) return false;
        boolean removed = file(id).delete();
        removeFromIndex(id);
        /* Attachments are named <chatId>-<n>-<original>, so they can be matched. */
        File[] files = attachmentDir().listFiles();
        if (files != null) {
            for (File f : files) {
                if (f.getName().startsWith(id + "-")) f.delete();
            }
        }
        return removed;
    }

    /** Remove every chat. Returns how many transcripts were deleted. */
    public synchronized int deleteAll() {
        String[] names = dir.list();
        int n = 0;
        if (names != null) {
            for (String s : names) {
                if (!s.endsWith(".json")) continue;
                /* The index is metadata, not a transcript: never count it, and
                   rewrite it empty rather than leaving the drawer to rebuild. */
                if (s.equals("index.json")) continue;
                if (!isSafeId(s.substring(0, s.length() - 5))) continue;
                if (new File(dir, s).delete()) n++;
            }
        }
        File[] files = attachmentDir().listFiles();
        if (files != null) for (File f : files) f.delete();
        writeIndex(new ArrayList<Meta>());
        return n;
    }

    /**
     * Keep a copy of a picked file. Returns the stored File, or null on failure.
     * Named <chatId>-<n>-<safe-original> so delete() can clean up by chat.
     */
    public synchronized File storeAttachment(String chatId, byte[] bytes, String originalName) {
        if (!isSafeId(chatId) || bytes == null) return null;
        String safe = originalName == null ? "file" : originalName.replaceAll("[^A-Za-z0-9._-]", "_");
        if (safe.length() > 60) safe = safe.substring(safe.length() - 60);
        int n = 0;
        File out;
        do {
            out = new File(attachmentDir(), chatId + "-" + (n++) + "-" + safe);
        } while (out.exists());
        try (FileOutputStream fos = new FileOutputStream(out)) {
            fos.write(bytes);
            return out;
        } catch (IOException e) {
            return null;
        }
    }

    // -------------------------------------------------------------- index

    private Meta metaOf(ChatSession s) {
        return new Meta(s.id, s.title, s.updatedAt, s.messages.size(), s.engine);
    }

    private List<Meta> readIndex() {
        if (!indexFile.isFile()) return null;
        try {
            JSONObject root = new JSONObject(read(indexFile));
            JSONArray a = root.optJSONArray("sessions");
            if (a == null) return null;
            List<Meta> out = new ArrayList<>();
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.optJSONObject(i);
                if (o == null) continue;
                String id = o.optString("id", "");
                if (!isSafeId(id) || !file(id).isFile()) continue;   // stale entry
                out.add(new Meta(id, o.optString("title", "New chat"),
                        o.optLong("updatedAt", 0), o.optInt("messageCount", 0),
                        o.has("engine") && !o.isNull("engine") ? o.optString("engine") : null));
            }
            return out;
        } catch (Exception e) {
            return null;
        }
    }

    /** Scan the directory and rewrite index.json from what is actually there. */
    private List<Meta> rebuildIndex() {
        List<Meta> out = new ArrayList<>();
        String[] names = dir.list();
        if (names != null) {
            for (String n : names) {
                if (!n.endsWith(".json") || n.equals("index.json")) continue;
                String id = n.substring(0, n.length() - 5);
                if (!isSafeId(id)) continue;
                ChatSession s = load(id);
                if (s == null) continue;            // corrupt: skip, keep the rest
                out.add(metaOf(s));
            }
        }
        writeIndex(out);
        return out;
    }

    private void upsertIndex(Meta m) {
        List<Meta> metas = readIndex();
        if (metas == null) metas = rebuildIndex();
        for (int i = 0; i < metas.size(); i++) {
            if (metas.get(i).id.equals(m.id)) { metas.set(i, m); writeIndex(metas); return; }
        }
        metas.add(m);
        writeIndex(metas);
    }

    private void removeFromIndex(String id) {
        List<Meta> metas = readIndex();
        if (metas == null) return;
        boolean changed = false;
        for (int i = metas.size() - 1; i >= 0; i--) {
            if (metas.get(i).id.equals(id)) { metas.remove(i); changed = true; }
        }
        if (changed) writeIndex(metas);
    }

    private void writeIndex(List<Meta> metas) {
        try {
            JSONArray a = new JSONArray();
            for (Meta m : metas) {
                JSONObject o = new JSONObject();
                o.put("id", m.id);
                o.put("title", m.title);
                o.put("updatedAt", m.updatedAt);
                o.put("messageCount", m.messageCount);
                if (m.engine != null) o.put("engine", m.engine);
                a.put(o);
            }
            JSONObject root = new JSONObject();
            root.put("v", 1);
            root.put("sessions", a);
            writeAtomic(indexFile, root.toString());
        } catch (Exception ignored) { }
    }

    // --------------------------------------------------------------- io

    private static String read(File f) throws IOException {
        byte[] buf = new byte[(int) f.length()];
        int got = 0;
        try (java.io.InputStream in = new java.io.FileInputStream(f)) {
            while (got < buf.length) {
                int r = in.read(buf, got, buf.length - got);
                if (r < 0) break;
                got += r;
            }
        }
        return new String(buf, 0, got, StandardCharsets.UTF_8);
    }

    /** Write to a temp file, then rename over the target. */
    private static void writeAtomic(File target, String content) throws IOException {
        File tmp = new File(target.getParentFile(), target.getName() + ".tmp");
        Writer w = new OutputStreamWriter(new FileOutputStream(tmp), StandardCharsets.UTF_8);
        try {
            w.write(content);
            w.flush();
        } finally {
            w.close();
        }
        if (target.exists() && !target.delete()) {
            throw new IOException("could not replace " + target.getName());
        }
        if (!tmp.renameTo(target)) {
            /* renameTo is not guaranteed across filesystems; fall back to a copy. */
            byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
            try (FileOutputStream fos = new FileOutputStream(target)) { fos.write(bytes); }
            tmp.delete();
        }
    }
}
