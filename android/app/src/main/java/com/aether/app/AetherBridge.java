package com.aether.app;

import android.content.Context;
import android.webkit.JavascriptInterface;

/**
 * The native half of the contract in src/lib/control-auth.ts:10, which expects
 * window.AetherNative.controlToken() -> string.
 *
 * In this build the WebView loads an ENGINE, not the Aether web app, and the
 * engine's own chat page authenticates with the X-Engine-Key header. The bridge
 * is still exposed so anything Aether-shaped loaded here can resolve a token,
 * and so the engine key reaches the page without being written into a URL --
 * where it would land in browser history and proxy logs.
 *
 * Only these getters are exposed. No file, exec or navigation surface, so a
 * compromised page cannot reach anything else on the device.
 *
 * R8 keeps both methods and their @JavascriptInterface annotations; that is
 * asserted by dexdump -a on the built release, not assumed.
 */
public final class AetherBridge {

    private final Credentials.Config cfg;

    public AetherBridge(Context ctx, Credentials.Config cfg) {
        this.cfg = cfg;
    }

    @JavascriptInterface
    public String controlToken() {
        return cfg == null ? "" : nullToEmpty(cfg.offKey);
    }

    @JavascriptInterface
    public String engineKey() {
        return cfg == null ? "" : nullToEmpty(cfg.offKey);
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}
