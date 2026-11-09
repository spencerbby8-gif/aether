package com.aether.app;

/**
 * Turns a backup-service status/code into text a person can act on.
 *
 * Kept free of Android imports so it can be compiled and exercised on a plain
 * JVM by scripts/proofs/DriveBrokerErrorsProof.java. No case may ever read like
 * a success, and no case may echo token material.
 */
public final class DriveErrors {
    private DriveErrors() { }

    public static String message(int status, String error) {
        String code = error == null ? "" : error;
        switch (code) {
            case "not_signed_in": return "Sign in to your Aether account before using Drive backup.";
            case "drive_not_configured": return "Drive backup is not configured on the server yet.";
            case "not_connected": return "Google Drive is not connected. Connect it to back up.";
            case "reconnect_required": return "Google Drive access was revoked. Reconnect to continue.";
            case "no_refresh_token": return "Google did not grant lasting access. Reconnect and approve the prompt.";
            case "invalid_grant": return "Google rejected the saved Drive access. Reconnect to continue.";
            case "store_failed": return "The server could not save the Drive link. Try again.";
            case "bad_code": return "Google returned an unusable authorization code. Try again.";
            case "network": return "Could not reach the backup service. Check your connection.";
            default: break;
        }
        if (status == 401 || status == 403) return "Your Aether session expired. Sign in again.";
        if (status == 404) return "Google Drive is not connected. Connect it to back up.";
        if (status >= 500) return "The backup service failed. Try again in a moment.";
        return "Google Drive request failed" + (status > 0 ? " (HTTP " + status + ")" : "") + ".";
    }
}
