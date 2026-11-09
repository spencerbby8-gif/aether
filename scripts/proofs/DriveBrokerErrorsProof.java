import com.aether.app.DriveErrors;

/**
 * Proof for the one part of the Drive backup path that can be tested without a
 * device or an account: the mapping from a backup-service failure to the text
 * a person actually reads.
 *
 * What it enforces:
 *   1. Every documented failure code has its own specific guidance.
 *   2. No failure ever reads like a success -- a broken Drive must never look
 *      like a completed backup.
 *   3. No message echoes token material or a raw Google payload.
 *   4. Unknown codes and odd statuses still produce honest, bounded text.
 */
public final class DriveBrokerErrorsProof {
    static int pass, fail;
    static void check(String name, boolean ok, Object detail) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + name + "  [" + detail + "]");
        if (ok) pass++; else fail++;
    }

    public static void main(String[] args) {
        String[] codes = {
            "not_signed_in", "drive_not_configured", "not_connected", "reconnect_required",
            "no_refresh_token", "invalid_grant", "store_failed", "bad_code", "network",
        };
        java.util.Set<String> distinct = new java.util.HashSet<>();
        for (String code : codes) {
            String text = DriveErrors.message(400, code);
            distinct.add(text);
            check("code " + code + " has guidance", text != null && text.trim().length() > 12, text);
        }
        check("each documented code maps to distinct guidance", distinct.size() == codes.length, distinct.size() + "/" + codes.length);

        // A failure must never be mistakable for the success line the UI writes.
        // "not connected" is a failure statement, so the bare word is not on this
        // list; a positive claim is. Affirmative "connected" is caught below.
        String[] successLike = {"complete", "backed up", "success", "done", "is connected"};
        int successHits = 0;
        for (String code : codes) {
            String lower = DriveErrors.message(400, code).toLowerCase(java.util.Locale.ROOT);
            for (String word : successLike) {
                if (lower.contains(word)) {
                    successHits++;
                    System.out.println("        leak: " + code + " -> " + lower);
                }
            }
        }
        check("no failure message reads like a success", successHits == 0, successHits + " success-like words");

        // Any mention of being connected must be a negation or a call to reconnect.
        int unnegated = 0;
        for (String code : codes) {
            String text = DriveErrors.message(400, code);
            if (text.contains("connected") && !text.contains("not connected") && !text.contains("Reconnect")) {
                unnegated++;
                System.out.println("        unnegated: " + code + " -> " + text);
            }
        }
        check("every mention of being connected is a negation or a reconnect request", unnegated == 0, unnegated + " affirmative");

        // Token material must never reach the screen through an error path.
        String[] forbidden = {"refresh_token", "access_token", "ya29.", "client_secret", "bearer "};
        int leaks = 0;
        StringBuilder all = new StringBuilder();
        for (String code : codes) all.append(DriveErrors.message(400, code)).append('\n');
        for (int status : new int[]{0, 401, 403, 404, 409, 418, 429, 500, 502, 503}) all.append(DriveErrors.message(status, "")).append('\n');
        String blob = all.toString().toLowerCase(java.util.Locale.ROOT);
        for (String word : forbidden) if (blob.contains(word)) { leaks++; System.out.println("        leak: " + word); }
        check("no error text contains token material", leaks == 0, leaks + " leaks");

        check("401 says the session expired", DriveErrors.message(401, "").contains("session expired"), DriveErrors.message(401, ""));
        check("404 says Drive is not connected", DriveErrors.message(404, "").contains("not connected"), DriveErrors.message(404, ""));
        check("5xx says the service failed", DriveErrors.message(503, "").contains("failed"), DriveErrors.message(503, ""));
        check("unknown code with 200 still reports failure", !DriveErrors.message(200, "something_new").toLowerCase(java.util.Locale.ROOT).contains("complete"), DriveErrors.message(200, "something_new"));
        check("network failure is reported, not swallowed", DriveErrors.message(-1, "network").contains("connection"), DriveErrors.message(-1, "network"));
        check("text stays short enough to read in the status line", DriveErrors.message(500, "").length() < 120, DriveErrors.message(500, "").length() + " chars");
        check("null code and status do not throw", DriveErrors.message(0, null) != null, DriveErrors.message(0, null));

        System.out.println("\nDRIVE BROKER ERRORS PROOF  " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }
}
