import com.aether.app.core.MediaItem;
import com.aether.app.core.WebImages;

import java.util.List;

/**
 * Images found on the web, before they are allowed anywhere near the chat.
 *
 * The interesting cases are the rejections. A page the agent fetched is not
 * trusted input, and the difference between "renders an image" and "renders
 * whatever that page told us to" is entirely in this filter.
 *
 * Run: java -cp /tmp/jvm-suite WebImagesProof
 */
public class WebImagesProof {
    static int passed = 0, failed = 0;

    static void chk(String what, boolean ok, String seen) {
        System.out.println("  " + (ok ? "ok  " + what : "FAIL " + what) + "   [" + seen + "]");
        if (ok) passed++; else failed++;
    }

    public static void main(String[] args) {
        System.out.println("== a real image in an answer ==");
        String md = "Here is the diagram: ![fuel cell stack](https://cdn.example.com/a/b/stack.png) "
                  + "and it shows the layers.";
        List<MediaItem> a = WebImages.find(md);
        chk("a markdown image is found", a.size() == 1, a.size() + " item(s)");
        chk("it is an image, sourced from the web",
                !a.isEmpty() && a.get(0).isImage() && "web".equals(a.get(0).source),
                a.isEmpty() ? "-" : a.get(0).kind + "/" + a.get(0).source);
        chk("the URL survives intact", !a.isEmpty()
                && "https://cdn.example.com/a/b/stack.png".equals(a.get(0).url),
                a.isEmpty() ? "-" : a.get(0).url);
        String stripped = WebImages.strip(md);
        chk("the raw URL is not dumped into the chat", !stripped.contains("https://"), stripped);
        chk("the alt text is kept where the link was",
                stripped.contains("fuel cell stack"), stripped);
        chk("the sentence around it still reads", stripped.startsWith("Here is the diagram:"),
                stripped);

        System.out.println("\n== a bare link the model just pasted ==");
        String bare = "See https://img.example.org/photo.jpg for the photo.";
        List<MediaItem> b = WebImages.find(bare);
        chk("a bare image link is found", b.size() == 1, b.size() + " item(s)");
        chk("trailing prose punctuation is not part of the URL",
                !b.isEmpty() && b.get(0).url.endsWith(".jpg"),
                b.isEmpty() ? "-" : b.get(0).url);
        chk("the bare URL is removed from the prose",
                !WebImages.strip(bare).contains("http"), WebImages.strip(bare));

        System.out.println("\n== hostile input is refused, not rendered ==");
        chk("a javascript: URL is refused", WebImages.find(
                "![x](javascript:alert(1))").isEmpty(), "rejected");
        chk("a data: URL is refused", WebImages.find(
                "![x](data:text/html;base64,PHNjcmlwdD4=)").isEmpty(), "rejected");
        chk("credentials in the userinfo are refused", WebImages.find(
                "https://user:pass@evil.example.com/x.jpg").isEmpty(), "rejected");
        chk("a non-image extension is refused", WebImages.find(
                "https://evil.example.com/payload.php.jpg.exe").isEmpty(), "rejected");
        chk("an HTML page is refused", WebImages.find(
                "https://example.com/page.html").isEmpty(), "rejected");
        chk("a URL with no extension is refused", WebImages.find(
                "https://example.com/track/9f8a7b").isEmpty(), "rejected");
        chk("an ftp link is refused", WebImages.find("ftp://x.example.com/a.jpg").isEmpty(),
                "rejected");

        System.out.println("\n== formats the loader can decode ==");
        for (String ext : new String[]{"jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"}) {
            chk("." + ext + " renders inline",
                    WebImages.find("https://c.example.com/i." + ext).size() == 1, ext);
        }
        chk(".svg is refused (scriptable)",
                WebImages.find("https://c.example.com/i.svg").isEmpty(), "rejected");
        chk(".tiff is refused (not decodable here)",
                WebImages.find("https://c.example.com/i.tiff").isEmpty(), "rejected");

        System.out.println("\n== messy real-world text ==");
        chk("a query string after the extension is fine",
                WebImages.find("https://c.example.com/i.jpg?w=800&h=600").size() == 1, "");
        chk("an HTML-escaped ampersand is unescaped",
                WebImages.find("https://c.example.com/i.jpg?a=1&amp;b=2").get(0).url
                        .contains("a=1&b=2"),
                WebImages.find("https://c.example.com/i.jpg?a=1&amp;b=2").get(0).url);
        chk("a fragment is fine",
                WebImages.find("https://c.example.com/i.png#center").size() == 1, "");
        chk("uppercase extension is fine",
                WebImages.find("https://c.example.com/I.JPG").size() == 1, "");

        System.out.println("\n== dedupe and the gallery cap ==");
        String dup = "https://c.example.com/same.png and again https://c.example.com/same.png";
        chk("the same image twice is one card", WebImages.find(dup).size() == 1,
                WebImages.find(dup).size() + " item(s)");
        StringBuilder many = new StringBuilder();
        for (int i = 0; i < 20; i++) many.append("https://c.example.com/p").append(i).append(".jpg ");
        chk("an answer full of images is capped, not a 20-deep gallery",
                WebImages.find(many.toString()).size() == WebImages.MAX_PER_MESSAGE,
                WebImages.find(many.toString()).size() + " of 20");

        System.out.println("\n== a non-image link is left alone ==");
        String cite = "Source: https://www.reuters.com/article/fuel-prices";
        chk("a citation is not treated as an image", WebImages.find(cite).isEmpty(), "rejected");
        chk("and the citation stays in the answer, because it is the source",
                WebImages.strip(cite).contains("reuters.com"), WebImages.strip(cite));

        System.out.println("\n== nothing to do ==");
        chk("plain prose yields nothing", WebImages.find("No links here at all.").isEmpty(), "");
        chk("plain prose is unchanged",
                "No links here at all.".equals(WebImages.strip("No links here at all.")), "");
        chk("null is handled", WebImages.find(null).isEmpty() && WebImages.strip(null) == null, "");

        System.out.println("\n" + passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }
}
