package com.aether.app;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.View;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;

/**
 * Hosts the live engine's own chat page.
 *
 * The engine serves a complete chat UI at "/" (do_GET in the engine notebook),
 * so the APK does not need to ship an interface of its own -- it needs to get
 * the user to the right tunnel URL and keep that connection honest.
 *
 * Streaming therefore happens in the engine's page over its own fetch: the same
 * path the web app uses, and the one already proven against a real engine (two
 * consecutive rounds, tool calls, cancellation). What this Activity adds is what
 * a WebView gets wrong by default: refusing bad certificates, not blanking the
 * page when a subresource fails, and keeping the engine key out of the URL.
 */
public class MainActivity extends AppCompatActivity {

    private WebView web;
    private View errorPane;
    private TextView errorText;
    private String targetUrl;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        web = findViewById(R.id.web);
        errorPane = findViewById(R.id.error_pane);
        errorText = findViewById(R.id.error_text);

        SharedPreferences p = getSharedPreferences("aether_console", MODE_PRIVATE);
        targetUrl = p.getString("activeUrl", null);
        if (targetUrl == null) {
            finish();
            return;
        }

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        /* Tunnel URLs are https-only. Refusing mixed content stops anything on
           the path from injecting script into a page that holds the engine key. */
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);

        web.addJavascriptInterface(new AetherBridge(this, Credentials.load(this)), "AetherNative");
        web.setBackgroundColor(0xFF0B0D12);
        web.setWebViewClient(new Client());

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (web != null && web.canGoBack()) web.goBack();
                else finish();
            }
        });

        Button retry = findViewById(R.id.retry);
        retry.setOnClickListener(v -> load());
        Button back = findViewById(R.id.back);
        back.setOnClickListener(v -> finish());

        load();
    }

    private void load() {
        errorPane.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(targetUrl);
    }

    private void showError(String message) {
        web.setVisibility(View.GONE);
        errorPane.setVisibility(View.VISIBLE);
        errorText.setText(message);
    }

    private final class Client extends WebViewClient {
        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            errorPane.setVisibility(View.GONE);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme();
            if (scheme == null) return false;
            if (scheme.equals("http") || scheme.equals("https")) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) {
            }
            return true;
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            /* Never proceed past a bad certificate. This page carries the engine
               key, so continuing would hand it to whoever is intercepting. */
            handler.cancel();
            showError("Certificate error talking to the engine.\n\nThe connection was refused "
                    + "rather than trusted.\n\n" + error);
        }

        @Override
        public void onReceivedError(WebView view, int code, String description, String failingUrl) {
            /* Main frame only. A broken favicon must not blank a working chat. */
            if (failingUrl != null && failingUrl.equals(targetUrl)) {
                showError("The engine stopped responding.\n\n" + description
                        + "\n\nIt may have idled out. Go back and wake it again.");
            }
        }
    }
}
