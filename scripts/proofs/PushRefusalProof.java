import com.aether.app.EngineCore;

/**
 * A push Kaggle refuses with HTTP 200 must not read as a successful wake.
 *
 * The quota body below is verbatim from the live API, captured when engine A
 * hit its 30 hour weekly GPU limit. The HTTP status was 200, so anything
 * checking only the status treated the engine as waking and then waited for a
 * kernel that had never been created.
 */
public class PushRefusalProof {
    static int pass, fail;

    static void chk(String what, boolean ok, String seen) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + what + "   [" + seen + "]");
        if (ok) pass++; else fail++;
    }

    static final String QUOTA = "{\"errorNullable\":\"Maximum weekly GPU quota of 30.00 hours reached.\","
            + "\"ref\":\"\",\"url\":\"\",\"versionNumber\":0,\"hasVersionNumber\":false,"
            + "\"error\":\"Maximum weekly GPU quota of 30.00 hours reached.\",\"hasError\":true,"
            + "\"kernelId\":0}";

    static final String ACCEPTED = "{\"errorNullable\":\"\",\"ref\":\"/code/user/slug v36\","
            + "\"url\":\"https://www.kaggle.com/code/user/slug\",\"versionNumber\":36,"
            + "\"hasVersionNumber\":true,\"error\":\"\",\"hasError\":false,\"kernelId\":123}";

    public static void main(String[] args) {
        System.out.println("== a refused push is never reported as a wake ==");

        String r = EngineCore.pushRefusal(QUOTA);
        chk("the real quota body is read as a refusal", r.contains("quota"), r);
        chk("an accepted push is not a refusal",
                EngineCore.pushRefusal(ACCEPTED).isEmpty(), EngineCore.pushRefusal(ACCEPTED));
        chk("a blank ref with no error is still a refusal",
                EngineCore.pushRefusal("{\"error\":\"\",\"ref\":\"\"}")
                        .equals("no kernel reference returned"),
                EngineCore.pushRefusal("{\"error\":\"\",\"ref\":\"\"}"));
        chk("a body we cannot parse is left alone",
                EngineCore.pushRefusal("not json").isEmpty(), "empty");
        chk("a null body is left alone", EngineCore.pushRefusal(null).isEmpty(), "empty");

        // This is the half that reaches the user: the refusal has to classify as
        // QUOTA, not as a generic error, and certainly not as waking.
        chk("the refusal classifies as a quota hit, so the UI shows QUOTA",
                EngineCore.isQuotaRefusal(-1, r), "isQuotaRefusal=" + EngineCore.isQuotaRefusal(-1, r));
        chk("an ordinary failure does not",
                !EngineCore.isQuotaRefusal(-1, "Kaggle push HTTP 500: boom"), "not quota");

        System.out.println("\n" + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }
}
