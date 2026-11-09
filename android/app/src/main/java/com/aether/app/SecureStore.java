package com.aether.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Small Android-Keystore-backed store for session/connector secrets. */
public final class SecureStore {
    private static final String ALIAS = "aether_private_data_v1";
    private final SharedPreferences prefs;

    public SecureStore(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences("aether_secure_values", Context.MODE_PRIVATE);
    }

    public synchronized void put(String name, String value) throws Exception {
        if (value == null || value.isEmpty()) throw new Exception("A secret value is required.");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = cipher.getIV();
        byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] joined = new byte[iv.length + encrypted.length];
        System.arraycopy(iv, 0, joined, 0, iv.length);
        System.arraycopy(encrypted, 0, joined, iv.length, encrypted.length);
        if (!prefs.edit().putString(name, Base64.encodeToString(joined, Base64.NO_WRAP)).commit()) {
            throw new Exception("Could not save private data on this device.");
        }
    }

    public synchronized String get(String name) throws Exception {
        String encoded = prefs.getString(name, "");
        if (encoded == null || encoded.isEmpty()) return "";
        byte[] joined = Base64.decode(encoded, Base64.NO_WRAP);
        if (joined.length < 13) throw new Exception("Saved private data is damaged.");
        byte[] iv = new byte[12], encrypted = new byte[joined.length - 12];
        System.arraycopy(joined, 0, iv, 0, 12);
        System.arraycopy(joined, 12, encrypted, 0, encrypted.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
    }

    public synchronized void remove(String name) { prefs.edit().remove(name).apply(); }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(ALIAS)) {
            return ((KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
}
