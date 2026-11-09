package com.aether.app;

import android.app.Dialog;
import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Elevated model chooser: one built-in destination plus personal provider/model cards. */
final class ModelPickerDialog {
    private ModelPickerDialog() { }

    static void show(Context context, ByokStore store, Runnable changed) {
        Dialog dialog = new Dialog(context);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        ScrollView scroll = new ScrollView(context);
        scroll.setFillViewport(false);
        LinearLayout sheet = new LinearLayout(context);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setBackgroundResource(R.drawable.bg_sheet);
        int h = Ui.dp(context, 20);
        sheet.setPadding(h, Ui.dp(context, 10), h, Ui.dp(context, 22));
        scroll.addView(sheet);
        dialog.setContentView(scroll);

        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawableResource(android.R.color.transparent);
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            window.setGravity(Gravity.BOTTOM);
            window.setDimAmount(.62f);
            window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            if (AetherPrefs.animations(context)) window.setWindowAnimations(R.style.AetherSheetAnimation);
        }
        dialog.setCanceledOnTouchOutside(true);

        View handle = new View(context);
        handle.setBackgroundResource(R.drawable.bg_pill_ghost);
        LinearLayout.LayoutParams handleLp = new LinearLayout.LayoutParams(Ui.dp(context, 42), Ui.dp(context, 4));
        handleLp.gravity = Gravity.CENTER_HORIZONTAL;
        handleLp.bottomMargin = Ui.dp(context, 18);
        sheet.addView(handle, handleLp);

        TextView title = Ui.tv(context, "Choose your model", 25, Ui.PRIMARY);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        sheet.addView(title);
        TextView subtitle = Ui.tv(context, "The right mind for this conversation.", 13, Ui.DIM);
        sheet.addView(subtitle, margins(context, 0, 5, 0, 18));

        boolean aetherSelected = !ModelPrefs.BYOK.equals(ModelPrefs.kind(context));
        LinearLayout builtIn = modelCard(context, R.drawable.ic_launcher_foreground,
                ModelPrefs.AETHER_LABEL, "Built in · research, tools and seamless continuity",
                aetherSelected ? "Selected" : "Ready", aetherSelected);
        builtIn.setOnClickListener(v -> {
            ModelPrefs.selectAether(context);
            dialog.dismiss();
            changed.run();
        });
        sheet.addView(builtIn, margins(context, 0, 0, 0, 10));

        java.util.List<ByokClient.Connection> connections = store.list();
        if (!connections.isEmpty()) {
            sheet.addView(sectionLabel(context, "PERSONAL PROVIDERS"));
            for (ByokClient.Connection c : connections) {
                if (!c.enabled || !c.hasKey) continue;
                boolean selected = ModelPrefs.BYOK.equals(ModelPrefs.kind(context))
                        && c.id.equals(ModelPrefs.connectionId(context));
                String status = "verified".equals(c.testStatus) ? "Verified" : "Key saved";
                LinearLayout card = modelCard(context, R.drawable.ic_provider, c.name,
                        c.defaultModel + " · " + status, selected ? "Selected" : "Choose", selected);
                card.setOnClickListener(v -> {
                    if (c.models.size() <= 1) {
                        String model = c.models.isEmpty() ? c.defaultModel : c.models.get(0);
                        ModelPrefs.selectByok(context, c.id, model);
                        dialog.dismiss(); changed.run();
                    } else {
                        sheet.removeView(card);
                        sheet.addView(modelChoices(context, dialog, c, changed), margins(context, 0, 0, 0, 10));
                    }
                });
                sheet.addView(card, margins(context, 0, 0, 0, 10));
            }
        }

        TextView manage = Ui.tv(context, "＋  Manage personal providers", 14, Ui.ACCENT);
        manage.setTypeface(Typeface.DEFAULT_BOLD);
        manage.setGravity(Gravity.CENTER);
        manage.setBackgroundResource(R.drawable.bg_pill_ghost);
        manage.setPadding(h, Ui.dp(context, 14), h, Ui.dp(context, 14));
        manage.setOnClickListener(v -> {
            Intent intent = new Intent(context, SettingsActivity.class);
            intent.putExtra("section", "providers");
            context.startActivity(intent);
            dialog.dismiss();
        });
        sheet.addView(manage, margins(context, 0, 8, 0, 0));

        TextView foot = Ui.tv(context, "Saved means the key is on this device. Verified means the provider answered a real test.", 11, Ui.DIM);
        foot.setGravity(Gravity.CENTER);
        sheet.addView(foot, margins(context, 8, 14, 8, 0));
        dialog.show();
        if (window != null) {
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            window.setGravity(Gravity.BOTTOM);
        }
    }

    private static LinearLayout modelChoices(Context context, Dialog dialog,
                                              ByokClient.Connection connection, Runnable changed) {
        LinearLayout box = new LinearLayout(context);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackgroundResource(R.drawable.bg_settings_row);
        box.setPadding(Ui.dp(context, 14), Ui.dp(context, 12), Ui.dp(context, 14), Ui.dp(context, 12));
        box.addView(sectionLabel(context, connection.name.toUpperCase(java.util.Locale.ROOT) + " · MODELS"));
        for (String model : connection.models) {
            TextView row = Ui.tv(context, model, 14, Ui.PRIMARY);
            row.setPadding(Ui.dp(context, 12), Ui.dp(context, 13), Ui.dp(context, 12), Ui.dp(context, 13));
            row.setOnClickListener(v -> {
                ModelPrefs.selectByok(context, connection.id, model);
                dialog.dismiss(); changed.run();
            });
            box.addView(row);
        }
        return box;
    }

    private static LinearLayout modelCard(Context context, int icon, String title, String detail,
                                          String action, boolean selected) {
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.HORIZONTAL);
        card.setGravity(Gravity.CENTER_VERTICAL);
        card.setBackgroundResource(selected ? R.drawable.bg_model_selected : R.drawable.bg_settings_row);
        card.setPadding(Ui.dp(context, 14), Ui.dp(context, 15), Ui.dp(context, 14), Ui.dp(context, 15));
        ImageView mark = new ImageView(context);
        mark.setImageResource(icon);
        mark.setBackgroundResource(R.drawable.bg_icon_tile);
        mark.setPadding(Ui.dp(context, 10), Ui.dp(context, 10), Ui.dp(context, 10), Ui.dp(context, 10));
        card.addView(mark, new LinearLayout.LayoutParams(Ui.dp(context, 46), Ui.dp(context, 46)));
        LinearLayout words = new LinearLayout(context);
        words.setOrientation(LinearLayout.VERTICAL);
        words.setPadding(Ui.dp(context, 12), 0, Ui.dp(context, 8), 0);
        TextView name = Ui.tv(context, title, 15, Ui.PRIMARY);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        name.setMaxLines(1);
        words.addView(name);
        TextView sub = Ui.tv(context, detail, 11, Ui.DIM);
        sub.setMaxLines(2);
        words.addView(sub);
        card.addView(words, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView state = Ui.tv(context, action, 11, selected ? Ui.ACCENT : Ui.DIM);
        state.setTypeface(Typeface.DEFAULT_BOLD);
        card.addView(state);
        card.setClickable(true);
        card.setFocusable(true);
        return card;
    }

    private static TextView sectionLabel(Context context, String text) {
        TextView label = Ui.tv(context, text, 10, Ui.DIM);
        label.setLetterSpacing(.12f);
        label.setTypeface(Typeface.DEFAULT_BOLD);
        label.setPadding(Ui.dp(context, 3), Ui.dp(context, 12), 0, Ui.dp(context, 7));
        return label;
    }

    private static LinearLayout.LayoutParams margins(Context context, int left, int top, int right, int bottom) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(Ui.dp(context, left), Ui.dp(context, top), Ui.dp(context, right), Ui.dp(context, bottom));
        return lp;
    }
}
