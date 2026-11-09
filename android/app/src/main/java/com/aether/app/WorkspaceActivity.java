package com.aether.app;

import android.app.AlertDialog;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

import org.json.JSONArray;
import org.json.JSONObject;

/** File browser/editor connected to the same per-chat remote workspace as tools. */
public final class WorkspaceActivity extends AppCompatActivity {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private String engine, key, session, path = "", openPath;
    private LinearLayout rows;
    private TextView subtitle;
    private EditText editor;
    private LinearLayout editorActions;
    private boolean loading;

    @Override protected void onCreate(@Nullable Bundle state) {
        super.onCreate(state);
        engine = getIntent().getStringExtra("engine");
        key = getIntent().getStringExtra("key");
        session = getIntent().getStringExtra("session");
        if (session == null || session.isEmpty()) session = "default";

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(getColor(R.color.aether_bg));
        root.setPadding(Ui.dp(this, 18), Ui.dp(this, 10), Ui.dp(this, 18), Ui.dp(this, 10));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        ImageView back = new ImageView(this);
        back.setImageResource(R.drawable.ic_back);
        back.setPadding(Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10));
        back.setContentDescription("Back");
        back.setOnClickListener(v -> finish());
        header.addView(back, new LinearLayout.LayoutParams(Ui.dp(this, 48), Ui.dp(this, 48)));
        LinearLayout titles = new LinearLayout(this); titles.setOrientation(LinearLayout.VERTICAL);
        TextView title = Ui.tv(this, "Workspace", 25, Ui.PRIMARY); title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        subtitle = Ui.tv(this, "Agent files · " + session, 11, Ui.DIM);
        titles.addView(title); titles.addView(subtitle);
        header.addView(titles, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView add = Ui.tv(this, "+ New", 13, Ui.ACCENT);
        add.setGravity(Gravity.CENTER); add.setPadding(Ui.dp(this, 12), 0, Ui.dp(this, 8), 0);
        add.setOnClickListener(v -> newFileDialog());
        header.addView(add, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Ui.dp(this, 48)));
        root.addView(header);

        TextView explanation = Ui.tv(this,
                "Inspect and edit the files your Agent creates. Changes are saved directly to this chat’s active workspace; review generated content before using it.",
                12, Ui.DIM);
        explanation.setPadding(0, Ui.dp(this, 14), 0, Ui.dp(this, 14));
        root.addView(explanation);

        LinearLayout toolbar = new LinearLayout(this);
        TextView up = action("↑ Up", v -> goUp());
        TextView refresh = action("Refresh", v -> load());
        TextView folder = action("+ Folder", v -> newFolderDialog());
        TextView rollback = action("Rollback", v -> confirmRollback());
        toolbar.addView(up); toolbar.addView(refresh); toolbar.addView(folder); toolbar.addView(rollback);
        root.addView(toolbar);

        editor = new EditText(this);
        editor.setTextColor(getColor(Ui.PRIMARY)); editor.setHintTextColor(getColor(Ui.DIM));
        editor.setTextSize(13); editor.setTypeface(Ui.mono(this));
        editor.setGravity(Gravity.TOP | Gravity.START);
        editor.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        editor.setBackgroundResource(R.drawable.bg_settings_row);
        editor.setPadding(Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14));
        editor.setVisibility(View.GONE);
        root.addView(editor, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        editorActions = new LinearLayout(this);
        TextView save = action("Save file", v -> save());
        TextView close = action("Close editor", v -> closeEditor());
        editorActions.addView(save); editorActions.addView(close);
        editorActions.setVisibility(View.GONE);
        root.addView(editorActions);

        ScrollView scroll = new ScrollView(this);
        rows = new LinearLayout(this); rows.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(rows);
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);
        Ui.applySystemBars(this);
        load();
    }

    private TextView action(String text, View.OnClickListener listener) {
        TextView view = Ui.tv(this, text, 12, Ui.ACCENT);
        view.setGravity(Gravity.CENTER);
        view.setPadding(Ui.dp(this, 8), 0, Ui.dp(this, 8), 0);
        view.setOnClickListener(listener);
        view.setLayoutParams(new LinearLayout.LayoutParams(0, Ui.dp(this, 48), 1f));
        return view;
    }

    private void load() {
        if (loading) return;
        loading = true;
        rows.removeAllViews(); rows.addView(Ui.centered(this, "Loading workspace…", 13, Ui.DIM));
        WorkspaceClient.list(engine, key, session, path, (ok, value) -> ui.post(() -> {
            loading = false; rows.removeAllViews();
            if (!ok) { rows.addView(Ui.centered(this, value, 13, Ui.ERROR)); return; }
            try {
                JSONObject result = new JSONObject(value); path = result.optString("path", path);
                subtitle.setText("Agent files · /" + path);
                JSONArray files = result.getJSONArray("files");
                if (files.length() == 0) rows.addView(Ui.centered(this, "This folder is empty.", 13, Ui.DIM));
                for (int i = 0; i < files.length(); i++) {
                    JSONObject file = files.getJSONObject(i);
                    LinearLayout row = new LinearLayout(this); row.setGravity(Gravity.CENTER_VERTICAL);
                    row.setBackgroundResource(R.drawable.bg_settings_row);
                    TextView name = Ui.tv(this, (file.optBoolean("directory") ? "▸  " : "·  ") + file.getString("name"), 14, Ui.PRIMARY);
                    name.setSingleLine(true); name.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
                    row.addView(name, new LinearLayout.LayoutParams(0, Ui.dp(this, 56), 1f));
                    if (!file.optBoolean("directory")) {
                        TextView size = Ui.meta(this, formatBytes(file.optLong("bytes"))); row.addView(size);
                    }
                    row.setOnClickListener(v -> open(file));
                    row.setOnLongClickListener(v -> { confirmDelete(file); return true; });
                    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                    lp.topMargin = Ui.dp(this, 6); rows.addView(row, lp);
                }
            } catch (Exception e) { rows.addView(Ui.centered(this, "Could not read the workspace response.", 13, Ui.ERROR)); }
        }));
    }

    private void open(JSONObject file) {
        String next = file.optString("path");
        if (file.optBoolean("directory")) { path = next; load(); return; }
        WorkspaceClient.read(engine, key, session, next, (ok, value) -> ui.post(() -> {
            if (!ok) { toast(value); return; }
            try {
                JSONObject result = new JSONObject(value);
                openPath = result.getString("path"); editor.setText(result.getString("content"));
                editor.setVisibility(View.VISIBLE); editorActions.setVisibility(View.VISIBLE);
                subtitle.setText("Editing · " + openPath);
            } catch (Exception e) { toast("Could not open that file"); }
        }));
    }

    private void save() {
        if (openPath == null) return;
        WorkspaceClient.write(engine, key, session, openPath, editor.getText().toString(), (ok, value) -> ui.post(() -> {
            toast(ok ? "Saved to Agent workspace" : value);
            if (ok) load();
        }));
    }

    private void closeEditor() {
        openPath = null; editor.setVisibility(View.GONE); editorActions.setVisibility(View.GONE); load();
    }

    private void goUp() {
        if (openPath != null) { closeEditor(); return; }
        int slash = path.lastIndexOf('/'); path = slash < 0 ? "" : path.substring(0, slash); load();
    }

    private void newFileDialog() {
        EditText name = new EditText(this); name.setHint("path/to/file.txt"); name.setSingleLine(true);
        new AlertDialog.Builder(this).setTitle("New text file").setView(name)
                .setNegativeButton("Cancel", null).setPositiveButton("Create", (d, w) -> {
                    String value = name.getText().toString().trim();
                    if (value.isEmpty()) return;
                    WorkspaceClient.write(engine, key, session, join(value), "", (ok, result) -> ui.post(() -> {
                        toast(ok ? "File created" : result); if (ok) load();
                    }));
                }).show();
    }

    private void newFolderDialog() {
        EditText name = new EditText(this); name.setHint("folder name"); name.setSingleLine(true);
        new AlertDialog.Builder(this).setTitle("New folder").setView(name)
                .setNegativeButton("Cancel", null).setPositiveButton("Create", (d, w) -> {
                    String value = name.getText().toString().trim(); if (value.isEmpty()) return;
                    WorkspaceClient.mkdir(engine, key, session, join(value), (ok, result) -> ui.post(() -> {
                        toast(ok ? "Folder created" : result); if (ok) load();
                    }));
                }).show();
    }

    private void confirmDelete(JSONObject file) {
        new AlertDialog.Builder(this).setTitle("Delete " + file.optString("name") + "?")
                .setMessage("This permanently removes it from the active Agent workspace.")
                .setNegativeButton("Cancel", null).setPositiveButton("Delete", (d, w) ->
                        WorkspaceClient.delete(engine, key, session, file.optString("path"), (ok, result) -> ui.post(() -> {
                            toast(ok ? "Deleted" : result); if (ok) load();
                        }))).show();
    }

    private void confirmRollback() {
        new AlertDialog.Builder(this).setTitle("Roll back the last workspace change?")
                .setMessage("Restore the checkpoint captured before the most recent Workspace edit or shell command. Current files in this chat’s workspace will be replaced. This does not undo external connector actions.")
                .setNegativeButton("Cancel", null).setPositiveButton("Restore checkpoint", (d, w) -> {
                    closeEditor();
                    WorkspaceClient.rollback(engine, key, session, (ok, result) -> ui.post(() -> {
                        toast(ok ? "Workspace checkpoint restored" : result); if (ok) load();
                    }));
                }).show();
    }

    private String join(String value) { return path.isEmpty() ? value : path + "/" + value; }
    private static String formatBytes(long value) {
        if (value < 1024) return value + " B";
        if (value < 1024 * 1024) return (value / 1024) + " KB";
        return String.format(java.util.Locale.US, "%.1f MB", value / 1048576.0);
    }

    private void toast(String value) { Toast.makeText(this, value, Toast.LENGTH_SHORT).show(); }
}
