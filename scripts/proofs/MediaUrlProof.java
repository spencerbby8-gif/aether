import com.aether.app.core.MediaItem;

/**
 * Generated media outlives the tunnel URL it was created behind. These pin the
 * rebasing so an image from an earlier engine session still loads.
 */
public class MediaUrlProof {
    static int pass = 0, fail = 0;
    static void check(String name, boolean ok) {
        if (ok) pass++; else { fail++; System.out.println("  FAIL " + name); }
    }
    public static void main(String[] a) {
        MediaItem img = new MediaItem("image",
                "https://old-tunnel-hostname-abc.trycloudflare.com/files/blue-cube.jpg",
                "generate_image");

        /* The path is what survives a restart. */
        check("path is the /files/ part", "/files/blue-cube.jpg".equals(img.path()));

        /* Rebased onto the engine that is live now. */
        String live = "https://new-tunnel-hostname-xyz.trycloudflare.com";
        check("rebases onto the live engine",
                "https://new-tunnel-hostname-xyz.trycloudflare.com/files/blue-cube.jpg"
                        .equals(img.resolveUrl(live)));
        check("recognises itself as stale", img.isStale(live));

        /* A trailing slash on the base must not produce a double slash. */
        check("no double slash",
                "https://live.example.com/files/blue-cube.jpg"
                        .equals(img.resolveUrl("https://live.example.com/")));

        /* No current base: keep what we have rather than return nothing. */
        check("no base keeps stored url", img.url.equals(img.resolveUrl(null)));
        check("empty base keeps stored url", img.url.equals(img.resolveUrl("")));
        check("not stale against no base", !img.isStale(null));

        /* A base that is not a URL must not be trusted. */
        check("non-http base ignored", img.url.equals(img.resolveUrl("ftp://x.example.com")));

        /* Web media is not engine-hosted and must be left exactly alone. */
        MediaItem web = new MediaItem("image", "https://cdn.example.com/photos/cat.png", "web_search");
        check("web media path is its path", "/photos/cat.png".equals(web.path()));
        check("web media rebases too when asked",
                "https://live.example.com/photos/cat.png".equals(web.resolveUrl("https://live.example.com")));

        /* Audio keeps its extension through a rebase. */
        MediaItem wav = new MediaItem("audio", "https://old.example.com/files/voice.wav", "generate_voice");
        check("audio rebases with extension",
                "https://live.example.com/files/voice.wav".equals(wav.resolveUrl("https://live.example.com")));
        check("audio suggested name keeps .wav", "voice.wav".equals(wav.suggestedName()));

        /* A query string must not become part of the saved file name. */
        MediaItem q = new MediaItem("image", "https://x.example.com/files/a.jpg?v=2", "generate_image");
        check("query stripped from name", "a.jpg".equals(q.suggestedName()));

        /* An item with no usable URL is invalid, so no broken card is shown. */
        MediaItem bad = new MediaItem("image", "not-a-url", "generate_image");
        check("invalid url rejected", !bad.isValid());
        check("invalid url resolves to null", bad.resolveUrl("https://live.example.com") == null);

        System.out.println("MediaUrlProof: " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }
}
