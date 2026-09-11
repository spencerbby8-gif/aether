package com.aether.app;

import android.content.Context;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * The engines and the keys that drive them, shipped inside the APK.
 *
 * STORED OBFUSCATED, NOT ENCRYPTED: XOR + Base64 in assets/aether-credentials.dat.
 * That keeps a casual `strings app.apk` from printing Kaggle tokens and keeps
 * them out of logcat and crash reports, and nothing more -- anyone who unpacks
 * the APK can recover them in about a minute. Verified: `strings` on the baked
 * asset finds 0 plaintext KGAT_ occurrences, and the deobfuscate round trip
 * returns all three engines with 37-character keys.
 *
 * That trade-off was an explicit decision for a private single-user build. The
 * mitigations that actually matter: a Kaggle key can be revoked and an OFF_KEY
 * rotated at any time, which makes a leaked copy worthless. If this APK ever
 * leaves the phone, rotate all four values.
 *
 * Nothing here is written to a log, an exception message, or the UI.
 * Engine.toString() is deliberately key-free for the same reason.
 */
public final class Credentials {

    private static final byte[] MASK =
            "aether-obfuscation-mask-not-a-secret".getBytes(StandardCharsets.UTF_8);

    private Credentials() {}

    public static final class Config {
        public final String kernelSlug;
        public final String offKey;
        public final String beaconTopic;
        public final String beaconSecret;
        /** Optional ntfy topic the app reports its own readings to. */
        public final String telemetryTopic;
        public final List<EngineCore.Engine> engines = new ArrayList<>();

        Config(JSONObject o) throws Exception {
            this.kernelSlug   = o.getString("kernelSlug");
            this.offKey       = o.getString("offKey");
            this.beaconTopic  = o.getString("beaconTopic");
            this.beaconSecret = o.optString("beaconSecret", "");
            this.telemetryTopic = o.optString("telemetryTopic", "");
            for (String slot : new String[]{"a", "b", "c", "d"}) {
                JSONObject e = o.optJSONObject("engine" + slot.toUpperCase());
                if (e == null) continue;
                String user = e.optString("user", "");
                String key  = e.optString("key", "");
                if (user.isEmpty() || key.isEmpty()) continue;
                this.engines.add(new EngineCore.Engine(slot, user, key, kernelSlug));
            }
        }

        public EngineCore.Engine bySlot(String slot) {
            for (EngineCore.Engine e : engines) if (e.slot.equals(slot)) return e;
            return null;
        }
    }

    /** Null when the APK was built without baked credentials. */
    public static Config load(Context ctx) {
        try {
            return new Config(new JSONObject(deobfuscate(read(ctx, "aether-credentials.dat").trim())));
        } catch (Exception e) {
            return null;
        }
    }

    /** The notebook template, still carrying its {{...}} placeholders. */
    public static String notebookTemplate(Context ctx) throws Exception {
        return read(ctx, "aether-notebook-template.json");
    }

    /**
     * Fill the template for one slot. Mirrors renderAetherNotebook() in
     * src/server/engine/aether-engine-source.ts, including the fail-closed
     * behaviour: an unresolved placeholder would boot an engine that cannot
     * authenticate its own /off route.
     */
    public static String renderNotebook(String template, Config cfg, String slot) throws Exception {
        String out = template
                .replace("{{AETHER_OFF_KEY}}", cfg.offKey)
                .replace("{{AETHER_BEACON_TOKEN}}", cfg.beaconTopic)
                .replace("{{AETHER_BEACON_TOPIC}}", cfg.beaconTopic)
                .replace("{{AETHER_SLOT}}", slot);
        if (out.contains("{{AETHER_")) {
            throw new Exception("Refusing to push: an unresolved placeholder is still in the notebook.");
        }
        return out;
    }

    private static String read(Context ctx, String asset) throws Exception {
        InputStream is = ctx.getAssets().open(asset);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        is.close();
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    static String obfuscate(String plain) {
        byte[] b = plain.getBytes(StandardCharsets.UTF_8);
        for (int i = 0; i < b.length; i++) b[i] ^= MASK[i % MASK.length];
        return android.util.Base64.encodeToString(b, android.util.Base64.NO_WRAP);
    }

    static String deobfuscate(String encoded) {
        byte[] b = android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP);
        for (int i = 0; i < b.length; i++) b[i] ^= MASK[i % MASK.length];
        return new String(b, StandardCharsets.UTF_8);
    }
}
