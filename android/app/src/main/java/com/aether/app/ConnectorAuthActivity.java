package com.aether.app;

import android.content.Intent;
import android.os.Bundle;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

/** Receives and validates the remote MCP OAuth callback. */
public final class ConnectorAuthActivity extends AppCompatActivity {
    private TextView status;

    @Override protected void onCreate(@Nullable Bundle saved) {
        super.onCreate(saved);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(Ui.dp(this, 24), Ui.dp(this, 40), Ui.dp(this, 24), Ui.dp(this, 24));
        root.setBackgroundColor(getColor(R.color.aether_bg));
        TextView title = Ui.tv(this, "Connector sign-in", 27, Ui.PRIMARY);
        title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        root.addView(title);
        status = Ui.tv(this, "Validating the OAuth callback…", 14, Ui.DIM);
        status.setPadding(0, Ui.dp(this, 20), 0, Ui.dp(this, 20));
        root.addView(status);
        TextView done = Ui.tv(this, "Return to Aether", 14, R.color.aether_on_accent);
        done.setGravity(android.view.Gravity.CENTER);
        done.setBackgroundResource(R.drawable.bg_pill_accent);
        done.setOnClickListener(v -> finish());
        root.addView(done, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 54)));
        setContentView(root);
        Ui.applySystemBars(this);
        if (getIntent() != null) handle(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent); handle(intent);
    }

    private void handle(Intent intent) {
        if (intent.getData() == null) { status.setText("No OAuth callback was supplied."); return; }
        ConnectorOAuth.handleCallback(this, intent.getData(), (message, connected) -> runOnUiThread(() -> {
            status.setText(message);
            status.setTextColor(getColor(connected ? Ui.PRIMARY : Ui.ERROR));
        }));
        intent.setData(null);
    }
}
