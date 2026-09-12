import com.aether.app.core.AttachmentText;

/**
 * A file the engine cannot read must say so. Before this, a PDF arrived with no
 * text and no reason, and the model described contents it had never seen.
 */
public class AttachmentBinaryProof {
    static int pass = 0, fail = 0;
    static void check(String name, boolean ok) {
        if (ok) pass++; else { fail++; System.out.println("  FAIL " + name); }
    }
    public static void main(String[] a) {
        /* Formats that genuinely cannot be read must be detected. */
        check("pdf by mime", AttachmentText.isUnsupportedBinary("application/pdf", "r.pdf"));
        check("pdf by extension", AttachmentText.isUnsupportedBinary("", "report.pdf"));
        check("png", AttachmentText.isUnsupportedBinary("image/png", "a.png"));
        check("zip", AttachmentText.isUnsupportedBinary("application/zip", "a.zip"));
        check("docx", AttachmentText.isUnsupportedBinary(
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "d.docx"));
        check("mp3", AttachmentText.isUnsupportedBinary("audio/mpeg", "v.mp3"));
        check("mp4", AttachmentText.isUnsupportedBinary("video/mp4", "v.mp4"));
        check("unknown octet-stream", AttachmentText.isUnsupportedBinary(
                "application/octet-stream", "mystery.bin"));
        check("no mime at all", AttachmentText.isUnsupportedBinary(null, "thing"));

        /* Text formats must NOT be flagged, or real files stop being read. */
        check("plain text not flagged", !AttachmentText.isUnsupportedBinary("text/plain", "a.txt"));
        check("markdown not flagged", !AttachmentText.isUnsupportedBinary("text/markdown", "a.md"));
        check("json not flagged", !AttachmentText.isUnsupportedBinary("application/json", "a.json"));
        check("csv not flagged", !AttachmentText.isUnsupportedBinary("text/csv", "a.csv"));
        check("xml not flagged", !AttachmentText.isUnsupportedBinary("application/xml", "a.xml"));
        check("python source not flagged", !AttachmentText.isUnsupportedBinary("text/x-python", "a.py"));

        /* The notice must name the file and state the limitation plainly. */
        String n = AttachmentText.unsupportedNotice("report.pdf", 184320, "application/pdf");
        check("notice names the file", n.contains("report.pdf"));
        check("notice gives the size", n.contains("184320"));
        check("notice gives the type", n.contains("application/pdf"));
        check("notice says it cannot be read", n.contains("cannot read"));
        check("notice tells the model not to guess", n.contains("rather than describing"));
        check("notice offers a way forward", n.contains("text, Markdown, JSON, CSV"));

        System.out.println("AttachmentBinaryProof: " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }
}
