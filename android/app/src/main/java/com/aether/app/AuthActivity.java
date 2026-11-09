package com.aether.app;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

/** Email and Google account entry with secure, persistent Supabase sessions. */
public final class AuthActivity extends AppCompatActivity {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private SupabaseAuth auth;
    private EditText email, password;
    private TextView status, primary, secondary;
    private boolean createMode;
    private boolean busy;

    @Override protected void onCreate(@Nullable Bundle state) {
        super.onCreate(state);
        auth = new SupabaseAuth(this);
        final boolean driveBackup = getIntent().getBooleanExtra("drive_backup", false);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(Ui.dp(this, 24), Ui.dp(this, 18), Ui.dp(this, 24), Ui.dp(this, 18));
        root.setBackgroundColor(getColor(R.color.aether_bg));
        ScrollView scroll = new ScrollView(this); scroll.addView(root); setContentView(scroll);
        Ui.applySystemBars(this);

        TextView back = Ui.tv(this, "‹  Back", 15, Ui.DIM); back.setGravity(Gravity.CENTER_VERTICAL);
        back.setOnClickListener(v -> finish()); root.addView(back, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, Ui.dp(this, 48)));
        TextView title = Ui.tv(this, "Your Aether account", 30, Ui.PRIMARY);
        title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        title.setPadding(0, Ui.dp(this, 42), 0, Ui.dp(this, 10)); root.addView(title);
        TextView intro = Ui.tv(this, "Sign in to synchronize your account, connector grants and app backups. Chat remains available without an account.", 14, Ui.DIM);
        root.addView(intro);

        TextView google = button(driveBackup ? "Connect Google Drive backup" : "Continue with Google", false);
        google.setOnClickListener(v -> {
            if (busy) return;
            busy = true; status("Opening secure Google sign-in…");
            try { auth.startGoogle(driveBackup); }
            catch (Exception e) { busy = false; status("Google sign-in could not open. Check that a browser is installed."); }
        });
        LinearLayout.LayoutParams gp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 54));
        gp.topMargin = Ui.dp(this, 34); root.addView(google, gp);

        TextView divider = Ui.tv(this, "OR USE EMAIL", 11, Ui.DIM); divider.setGravity(Gravity.CENTER);
        divider.setPadding(0, Ui.dp(this, 26), 0, Ui.dp(this, 16)); root.addView(divider);
        email = field("Email address", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        password = field("Password (8+ characters)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        root.addView(email); root.addView(password);

        primary = button("Sign in", true); primary.setOnClickListener(v -> submit());
        LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 54));
        pp.topMargin = Ui.dp(this, 20); root.addView(primary, pp);
        secondary = Ui.tv(this, "New to Aether? Create an account", 13, Ui.ACCENT); secondary.setGravity(Gravity.CENTER);
        secondary.setOnClickListener(v -> toggleMode()); root.addView(secondary, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 52)));
        TextView forgot = Ui.tv(this, "Forgot password?", 12, Ui.DIM); forgot.setGravity(Gravity.CENTER);
        forgot.setOnClickListener(v -> recover()); root.addView(forgot, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 44)));
        status = Ui.tv(this, "Email confirmation is required for new accounts. Google sign-in requires the project’s Google OAuth configuration.", 12, Ui.DIM);
        status.setPadding(0, Ui.dp(this, 18), 0, 0); root.addView(status);

        if (getIntent() != null && getIntent().getData() != null) handle(getIntent());
    }

    private EditText field(String hint, int type) {
        EditText field = new EditText(this); field.setHint(hint); field.setHintTextColor(getColor(Ui.DIM));
        field.setTextColor(getColor(Ui.PRIMARY)); field.setTextSize(15); field.setSingleLine(true); field.setInputType(type);
        field.setBackgroundResource(R.drawable.bg_settings_row);
        field.setPadding(Ui.dp(this, 15), 0, Ui.dp(this, 15), 0);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 56));
        lp.bottomMargin = Ui.dp(this, 10); field.setLayoutParams(lp); return field;
    }

    private TextView button(String text, boolean accent) {
        TextView button = Ui.tv(this, text, 14, accent ? R.color.aether_fg : Ui.PRIMARY);
        button.setGravity(Gravity.CENTER); button.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        button.setBackgroundResource(accent ? R.drawable.bg_pill_accent : R.drawable.bg_settings_row); return button;
    }

    private void toggleMode() {
        createMode = !createMode; primary.setText(createMode ? "Create account" : "Sign in");
        secondary.setText(createMode ? "Already have an account? Sign in" : "New to Aether? Create an account");
        status("");
    }

    private void submit() {
        String address = email.getText().toString().trim(); String secret = password.getText().toString();
        if (!android.util.Patterns.EMAIL_ADDRESS.matcher(address).matches()) { status("Enter a valid email address."); return; }
        if (secret.length() < 8) { status("Use at least 8 characters for your password."); return; }
        busy = true; primary.setEnabled(false); status(createMode ? "Creating your account…" : "Signing in…");
        SupabaseAuth.Callback callback = (ok, message) -> ui.post(() -> {
            busy = false; primary.setEnabled(true); status(message); if (ok && auth.session() != null) finish();
        });
        if (createMode) auth.signUp(address, secret, callback); else auth.signIn(address, secret, callback);
    }

    private void recover() {
        String address = email.getText().toString().trim();
        if (!android.util.Patterns.EMAIL_ADDRESS.matcher(address).matches()) { status("Enter your email address first."); return; }
        status("Requesting recovery email…");
        auth.resetPassword(address, (ok, message) -> ui.post(() -> status(message)));
    }

    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); handle(intent); }

    private void handle(Intent intent) {
        if (intent.getData() == null) return;
        busy = true; status("Completing secure sign-in…");
        auth.handleRedirect(intent.getData(), (ok, message) -> ui.post(() -> {
            busy = false; status(message); if (ok) finish();
        }));
        intent.setData(null);
    }

    private void status(String value) { if (status != null) status.setText(value); }
}
