package com.aether.app;

import android.content.Context;
import android.graphics.Typeface;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.content.ContextCompat;

/**
 * Tiny view helpers, in the spirit of the reference app's Ui class but with
 * Aether's tokens. Keeping every bubble, meta line and tool row built through
 * here means spacing, type and colour stay consistent across the whole app --
 * the thing a hand-rolled redesign most easily loses.
 */
final class Ui {

    static final int PRIMARY = R.color.aether_fg;
    static final int DIM = R.color.aether_muted;
    static final int ACCENT = R.color.aether_accent;
    static final int OK = R.color.aether_ok;
    static final int WARN = R.color.aether_warn;
    static final int ERROR = R.color.aether_error;

    private Ui() {}

    static int dp(Context c, float v) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, v, c.getResources().getDisplayMetrics()));
    }

    static TextView tv(Context c, String text, float sp, int colorRes) {
        TextView t = new TextView(c);
        t.setText(text);
        t.setTextSize(sp);
        t.setTextColor(ContextCompat.getColor(c, colorRes));
        t.setLineSpacing(dp(c, 2), 1f);
        return t;
    }

    static TextView meta(Context c, String text) {
        TextView t = tv(c, text, 11, DIM);
        return t;
    }

    /** Full-width centered guidance for empty and error surfaces. */
    static TextView centered(Context c, String text, float sp, int colorRes) {
        TextView t = tv(c, text, sp, colorRes);
        t.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(c, 24);
        lp.bottomMargin = dp(c, 24);
        lp.leftMargin = dp(c, 16);
        lp.rightMargin = dp(c, 16);
        t.setLayoutParams(lp);
        return t;
    }

    static Typeface mono(Context c) {
        return Typeface.MONOSPACE;
    }
}
