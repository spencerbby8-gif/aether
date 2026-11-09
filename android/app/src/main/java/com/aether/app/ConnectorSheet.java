package com.aether.app;

import android.app.AlertDialog;
import android.content.Context;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Connector catalog and explicit MCP permission editor. */
final class ConnectorSheet {
    interface Changed { void changed(); }

    private ConnectorSheet() { }

    static void show(Context context, Changed changed) {
        ConnectorStore store = new ConnectorStore(context);
        LinearLayout content = new LinearLayout(context); content.setOrientation(LinearLayout.VERTICAL);
        int pad = Ui.dp(context, 8); content.setPadding(pad, pad, pad, pad);
        TextView intro = Ui.tv(context, "Connectors become real Agent tools only after you enable them and grant permissions. Credentials are sent only to your HTTPS MCP server through the active encrypted engine connection.", 12, Ui.DIM);
        content.addView(intro);
        addCatalog(context, content, store, "GitHub", "Issues, repositories, pull requests and code through GitHub’s remote MCP server.", "https://api.githubcopilot.com/mcp/", changed);
        addCatalog(context, content, store, "Supabase", "Projects, database tools, edge functions, logs and docs through Supabase’s hosted MCP. OAuth uses PKCE; a personal access token is the fallback.", "https://mcp.supabase.com/mcp", changed);
        addCatalog(context, content, store, "Vercel", "Projects, deployments, logs and documentation through Vercel’s hosted MCP. OAuth depends on Vercel approving the dynamic client; token fallback remains available.", "https://mcp.vercel.com", changed);
        addCatalog(context, content, store, "Google Drive · agent connector", "Optional file tools. This grant is separate from account backup and does not enable backup.", "", changed);
        addCatalog(context, content, store, "Slack", "Connect your workspace’s HTTPS MCP endpoint and choose only the tools you need.", "", changed);
        addCatalog(context, content, store, "Notion", "Search and update permitted pages through an MCP endpoint you control.", "", changed);
        addCatalog(context, content, store, "Linear", "Read or manage issues through your team’s MCP endpoint.", "", changed);
        addCatalog(context, content, store, "Custom MCP server", "Any MCP server supporting Streamable HTTP JSON-RPC initialize, tools/list and tools/call.", "", changed);
        ScrollView scroll = new ScrollView(context); scroll.addView(content);
        new AlertDialog.Builder(context).setTitle("Connectors & MCP").setView(scroll)
                .setPositiveButton("Done", (d, w) -> changed.changed()).show();
    }

    private static void addCatalog(Context context, LinearLayout parent, ConnectorStore store,
                                   String name, String description, String url, Changed changed) {
        LinearLayout row = new LinearLayout(context); row.setOrientation(LinearLayout.VERTICAL);
        row.setBackgroundResource(R.drawable.bg_settings_row); row.setPadding(Ui.dp(context, 14), Ui.dp(context, 12), Ui.dp(context, 14), Ui.dp(context, 12));
        TextView title = Ui.tv(context, name, 15, Ui.PRIMARY); title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD); row.addView(title);
        TextView detail = Ui.tv(context, description, 11, Ui.DIM); row.addView(detail);
        TextView action = Ui.tv(context, "Configure permissions  ›", 12, Ui.ACCENT);
        action.setGravity(Gravity.CENTER_VERTICAL); row.addView(action, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(context, 42)));
        row.setOnClickListener(v -> editor(context, store, name, url, changed));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Ui.dp(context, 10); parent.addView(row, lp);
    }

    private static void editor(Context context, ConnectorStore store, String name, String defaultUrl, Changed changed) {
        ConnectorStore.Connector existing = null;
        for (ConnectorStore.Connector item : store.list()) if (item.name.equals(name)) { existing = item; break; }
        ConnectorStore.Connector value = existing == null ? new ConnectorStore.Connector() : existing.copy();
        value.name = name; if (value.url.isEmpty()) value.url = defaultUrl;
        if (existing == null && (name.equals("Supabase") || name.equals("Vercel"))) {
            value.read = true; value.write = true; value.execute = true;
        }
        LinearLayout form = new LinearLayout(context); form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(Ui.dp(context, 20), 0, Ui.dp(context, 20), 0);
        EditText url = input(context, "HTTPS MCP server URL", value.url, InputType.TYPE_TEXT_VARIATION_URI);
        EditText token = input(context, name.equals("GitHub") ? "GitHub personal access token" : "Bearer token (if required)", "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        EditText repo = input(context, "GitHub repository scope: owner/repository (optional)", value.repository, InputType.TYPE_CLASS_TEXT);
        if (name.equals("Vercel")) {
            repo.setHint("OAuth client metadata URL (HTTPS CIMD, optional)");
            repo.setText(value.oauthClientId); repo.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        }
        CheckBox read = check(context, "Read/search tools", value.read);
        CheckBox write = check(context, "Create/edit tools", value.write);
        CheckBox execute = check(context, "Execute/workflow tools", value.execute);
        CheckBox enabled = check(context, "Enable for Agent requests", value.enabled);
        form.addView(url); form.addView(token); if (name.equals("GitHub") || name.equals("Vercel")) form.addView(repo);
        form.addView(read); form.addView(write); form.addView(execute); form.addView(enabled);
        TextView oauth = null;
        if (name.equals("Supabase") || name.equals("Vercel")) {
            oauth = Ui.tv(context, "Connect securely with OAuth  ›", 14, Ui.ACCENT);
            oauth.setGravity(Gravity.CENTER); oauth.setBackgroundResource(R.drawable.bg_settings_row);
            form.addView(oauth, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(context, 52)));
        }
        TextView note = Ui.tv(context, "Read, create/edit and execute/workflow grants are enforced again on the engine. Hosted MCP permissions are broad by default here, but you can narrow them before connecting. Blank token keeps the saved token.", 11, Ui.DIM); form.addView(note);
        ScrollView scroll = new ScrollView(context); scroll.addView(form);
        AlertDialog.Builder builder = new AlertDialog.Builder(context).setTitle(name).setView(scroll)
                .setNegativeButton("Cancel", null).setPositiveButton("Save connector", (d, w) -> {
                    try {
                        saveEditor(store, value, url, token, repo, read, write, execute, enabled);
                        changed.changed();
                    } catch (Exception e) { android.widget.Toast.makeText(context, e.getMessage(), android.widget.Toast.LENGTH_LONG).show(); }
                });
        final String existingId = existing == null ? null : existing.id;
        if (existingId != null) builder.setNeutralButton("Remove", (d, w) -> { store.delete(existingId); changed.changed(); });
        AlertDialog dialog = builder.show();
        if (oauth != null) oauth.setOnClickListener(v -> {
            try {
                saveEditor(store, value, url, token, repo, read, write, execute, enabled);
                ConnectorStore.Connector saved = store.find(value.id);
                dialog.dismiss();
                android.os.Handler main = new android.os.Handler(context.getMainLooper());
                ConnectorOAuth.start(context, saved, (message, connected) -> main.post(() ->
                        android.widget.Toast.makeText(context, message, android.widget.Toast.LENGTH_LONG).show()));
            } catch (Exception e) { android.widget.Toast.makeText(context, e.getMessage(), android.widget.Toast.LENGTH_LONG).show(); }
        });
    }

    private static void saveEditor(ConnectorStore store, ConnectorStore.Connector value,
                                   EditText url, EditText token, EditText repo, CheckBox read,
                                   CheckBox write, CheckBox execute, CheckBox enabled) throws Exception {
        value.url = url.getText().toString().trim(); value.repository = repo.getText().toString().trim();
        if ("Vercel".equals(value.name)) value.oauthClientId = repo.getText().toString().trim();
        value.read = read.isChecked(); value.write = write.isChecked(); value.execute = execute.isChecked(); value.enabled = enabled.isChecked();
        store.save(value, token.getText().toString());
    }

    private static EditText input(Context context, String hint, String value, int type) {
        EditText input = new EditText(context); input.setHint(hint); input.setText(value); input.setSingleLine(true); input.setInputType(type);
        input.setTextSize(13); input.setTextColor(context.getColor(Ui.PRIMARY));
        input.setHintTextColor(context.getColor(Ui.DIM)); input.setBackgroundResource(R.drawable.bg_settings_row);
        input.setPadding(Ui.dp(context, 12), Ui.dp(context, 12), Ui.dp(context, 12), Ui.dp(context, 12)); return input;
    }
    private static CheckBox check(Context context, String text, boolean value) {
        CheckBox box = new CheckBox(context); box.setText(text); box.setChecked(value); box.setTextSize(13);
        box.setTextColor(context.getColor(Ui.PRIMARY)); return box;
    }
}
