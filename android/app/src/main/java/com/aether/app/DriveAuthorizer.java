package com.aether.app;

import android.app.Activity;
import android.content.Intent;
import android.content.IntentSender;

import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;

import java.util.Collections;

/**
 * Google Identity Services authorization, scoped to this app's private Drive
 * folder and requested with offline access.
 *
 * The offline request is what makes a backup durable: Google returns a
 * one-time server auth code that the Edge Function exchanges for a refresh
 * token. The refresh token is never present on the device.
 */
final class DriveAuthorizer {
    /** Only Aether's own app-data folder — no access to the user's other files. */
    static final String DRIVE_APPDATA = "https://www.googleapis.com/auth/drive.appdata";

    interface Result {
        void onServerAuthCode(String code);
        void onConsentRequired(IntentSender sender);
        void onError(String message);
    }

    private DriveAuthorizer() { }

    static void authorize(Activity activity, Result result) {
        try {
            AuthorizationRequest request = AuthorizationRequest.builder()
                    .setRequestedScopes(Collections.singletonList(new Scope(DRIVE_APPDATA)))
                    .requestOfflineAccess(SupabaseAuth.GOOGLE_WEB_CLIENT_ID)
                    .setPrompt(AuthorizationRequest.Prompt.CONSENT)
                    .build();
            Identity.getAuthorizationClient(activity)
                    .authorize(request)
                    .addOnSuccessListener(authorizationResult -> deliver(authorizationResult, result))
                    .addOnFailureListener(failure -> result.onError(explain(failure)));
        } catch (Throwable unavailable) {
            result.onError("Google Play services is required to connect Google Drive backup on this device.");
        }
    }

    /** Resume after the consent sheet returned a result. */
    static void afterConsent(Activity activity, Intent data, Result result) {
        try {
            deliver(Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(data), result);
        } catch (Throwable failure) {
            result.onError("Google Drive connection was cancelled.");
        }
    }

    private static void deliver(AuthorizationResult authorizationResult, Result result) {
        if (authorizationResult == null) { result.onError("Google returned no authorization result."); return; }
        if (authorizationResult.hasResolution()) {
            android.app.PendingIntent pending = authorizationResult.getPendingIntent();
            IntentSender sender = pending == null ? null : pending.getIntentSender();
            if (sender == null) { result.onError("Google Drive consent could not be opened."); return; }
            result.onConsentRequired(sender);
            return;
        }
        String code = authorizationResult.getServerAuthCode();
        if (code == null || code.isEmpty()) {
            // An access token without a server code would expire in an hour and
            // silently break the next backup, so refuse it instead.
            result.onError("Google did not grant lasting Drive access. Try connecting again and approve the request.");
            return;
        }
        result.onServerAuthCode(code);
    }

    private static String explain(Exception failure) {
        if (failure instanceof ApiException) {
            int status = ((ApiException) failure).getStatusCode();
            if (status == com.google.android.gms.common.api.CommonStatusCodes.SIGN_IN_REQUIRED
                    || status == com.google.android.gms.common.api.CommonStatusCodes.RESOLUTION_REQUIRED) {
                return "Google needs you to choose an account before backup can connect.";
            }
            if (status == com.google.android.gms.common.api.CommonStatusCodes.NETWORK_ERROR) {
                return "Could not reach Google. Check your connection and try again.";
            }
        }
        return "Google Drive consent could not be completed. Try again.";
    }
}
