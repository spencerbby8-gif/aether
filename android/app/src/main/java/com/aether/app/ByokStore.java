package com.aether.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Device-local BYOK persistence.
 *
 * Metadata lives in private SharedPreferences. Each API key is AES-GCM
 * encrypted with a non-exportable key in Android Keystore. Keys are not written
 * to chat history, logs, or exports. This is device protection, not a claim of
 * provider availability or cloud backup.
 */
public final class ByokStore {
    private static final String PREFS = "aether_byok";
    private static final String CONNECTIONS = "connections_v1";
    private static final String KEY_PREFIX = "api_key_v1_";
    private static final String ALIAS = "aether_byok_master_v1";

    private final SharedPreferences prefs;

    public ByokStore(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Metadata list; apiKey is intentionally blank. */
    public synchronized List<ByokClient.Connection> list() {
        List<ByokClient.Connection> out = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(prefs.getString(CONNECTIONS, "[]"));
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                if (item == null) continue;
                ByokClient.Connection c = ByokClient.Connection.fromMetadata(item);
                if (!c.id.isEmpty()) out.add(c);
            }
        } catch (Exception ignored) {
            return new ArrayList<>();
        }
        return out;
    }

    public synchronized ByokClient.Connection find(String id) {
        if (id == null) return null;
        for (ByokClient.Connection c : list()) if (c.id.equals(id)) return c;
        return null;
    }

    /** Full connection for one request; decrypts only the selected key. */
    public synchronized ByokClient.Connection withKey(String id) throws Exception {
        ByokClient.Connection c = find(id);
        if (c == null) return null;
        String encrypted = prefs.getString(KEY_PREFIX + id, "");
        if (encrypted == null || encrypted.isEmpty()) throw new Exception("The saved provider key is unavailable.");
        c.apiKey = decrypt(encrypted);
        return c;
    }

    /** Create or update. A blank key on edit retains the existing encrypted key. */
    public synchronized ByokClient.Connection save(ByokClient.Connection input) throws Exception {
        if (input == null) throw new Exception("A provider connection is required.");
        ByokClient.Connection c = input.copy();
        if (c.id == null || c.id.trim().isEmpty()) c.id = "byok_" + UUID.randomUUID().toString();
        ByokClient.Connection previous = find(c.id);
        if ((c.apiKey == null || c.apiKey.isEmpty()) && previous != null && previous.hasKey) {
            c.apiKey = withKey(c.id).apiKey;
        }
        ByokClient.Connection checked = ByokClient.validated(c);
        c.baseUrl = checked.baseUrl;
        c.provider = checked.provider;
        if (c.name == null || c.name.trim().isEmpty()) c.name = ByokClient.provider(c.provider).name;
        c.name = c.name.trim();
        c.defaultModel = c.defaultModel == null ? "" : c.defaultModel.trim();
        if (c.defaultModel.isEmpty() && !c.models.isEmpty()) c.defaultModel = c.models.get(0);
        if (c.defaultModel.isEmpty()) throw new Exception("At least one model ID is required.");

        String encrypted = encrypt(c.apiKey);
        List<ByokClient.Connection> all = list();
        boolean replaced = false;
        c.hasKey = true;
        c.apiKey = "";
        for (int i = 0; i < all.size(); i++) {
            if (all.get(i).id.equals(c.id)) {
                all.set(i, c);
                replaced = true;
                break;
            }
        }
        if (!replaced) all.add(c);
        JSONArray array = new JSONArray();
        for (ByokClient.Connection item : all) array.put(item.toMetadata());
        boolean ok = prefs.edit().putString(KEY_PREFIX + c.id, encrypted)
                .putString(CONNECTIONS, array.toString()).commit();
        if (!ok) throw new Exception("Could not save the provider on this device.");
        return c.copy();
    }

    public synchronized void delete(String id) {
        List<ByokClient.Connection> all = list();
        List<ByokClient.Connection> kept = new ArrayList<>();
        for (ByokClient.Connection c : all) if (!c.id.equals(id)) kept.add(c);
        writeMetadata(kept);
        prefs.edit().remove(KEY_PREFIX + id).apply();
    }

    public synchronized void clear() {
        List<ByokClient.Connection> all = list();
        SharedPreferences.Editor editor = prefs.edit();
        for (ByokClient.Connection c : all) editor.remove(KEY_PREFIX + c.id);
        editor.remove(CONNECTIONS).commit();
    }

    private void writeMetadata(List<ByokClient.Connection> all) {
        try {
            JSONArray array = new JSONArray();
            for (ByokClient.Connection c : all) array.put(c.toMetadata());
            prefs.edit().putString(CONNECTIONS, array.toString()).commit();
        } catch (Exception ignored) { }
    }

    private SecretKey masterKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) {
            KeyStore.SecretKeyEntry entry = (KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null);
            return entry.getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build());
        return generator.generateKey();
    }

    private String encrypt(String plain) throws Exception {
        if (plain == null || plain.isEmpty()) throw new Exception("An API key is required.");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, masterKey());
        byte[] iv = cipher.getIV();
        byte[] encrypted = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        byte[] joined = new byte[iv.length + encrypted.length];
        System.arraycopy(iv, 0, joined, 0, iv.length);
        System.arraycopy(encrypted, 0, joined, iv.length, encrypted.length);
        return Base64.encodeToString(joined, Base64.NO_WRAP);
    }

    private String decrypt(String encoded) throws Exception {
        byte[] joined = Base64.decode(encoded, Base64.NO_WRAP);
        if (joined.length < 13) throw new Exception("The saved provider key is damaged.");
        byte[] iv = new byte[12];
        byte[] encrypted = new byte[joined.length - 12];
        System.arraycopy(joined, 0, iv, 0, 12);
        System.arraycopy(joined, 12, encrypted, 0, encrypted.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, masterKey(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
    }
}
