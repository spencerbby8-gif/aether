package com.aether.app;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.aether.app.core.AgentActivity;
import com.aether.app.core.AgentRun;

import java.util.List;
import java.util.Locale;

/**
 * The live agent timeline: what Aether is doing, right now, in layers.
 *
 * Three ideas, in the order they matter:
 *
 *   ELEVATION. Depth means status. The run sits on a raised card, each phase is
 *   a surface inside it, and the phase that is actually executing is lifted
 *   above the others with a stronger border. A finished, folded run goes flat so
 *   old turns stop competing for attention.
 *
 *   ORGANISATION. Steps are grouped into consecutive phases (Understanding,
 *   Gathering, Browsing, Running, Creating) instead of one undifferentiated
 *   list. Each phase carries its own count, duration and live indicator, so a
 *   ten-step run reads as three things that happened, not ten that scrolled by.
 *
 *   HONESTY. Every row comes from {@link AgentActivity}, which drops anything
 *   the engine did not report. Nothing here animates once the turn is over, and
 *   no row is ever added to make the panel look busier.
 *
 * Animation is gated by the caller (AetherPrefs.animations); with it off the
 * widget renders the same information as a still image.
 */
final class AgentTimelineView extends LinearLayout {

    interface SourceOpener { void open(String url); }

    private final Context context;
    private final boolean animate;
    private final SourceOpener opener;
    private final LinearLayout body;
    private int openIndex = -1;
    /** Set once the person expands or collapses a row themselves; until then the
        executing step opens on its own, which is the point of the panel. */
    private boolean userToggled;

    AgentTimelineView(Context context, boolean animate, SourceOpener opener) {
        super(context);
        this.context = context;
        this.animate = animate;
        this.opener = opener;
        setOrientation(VERTICAL);
        setBackground(rounded(context.getColor(R.color.aether_surface), 18,
                context.getColor(R.color.aether_field_border), 1));
        setElevation(Ui.dp(context, 3));
        setClipToPadding(false);
        int pad = Ui.dp(context, 12);
        setPadding(pad, pad, pad, pad);
        body = new LinearLayout(context);
        body.setOrientation(VERTICAL);
        addView(body, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));
    }

    /** Rebuilds the whole run. Cheap enough for event-rate updates (one per step). */
    void bind(List<AgentRun.Phase> phases, boolean turnRunning) {
        lastPhases = phases;
        lastRunning = turnRunning;
        if (!userToggled) openIndex = runningIndex(phases);
        body.removeAllViews();
        if (phases.isEmpty()) return;
        int stepIndex = 0;
        for (int p = 0; p < phases.size(); p++) {
            AgentRun.Phase phase = phases.get(p);
            body.addView(phaseBlock(phase, phases.size(), p, stepIndex));
            stepIndex += phase.total();
        }
    }

    // ------------------------------------------------------------------ phases

    private View phaseBlock(AgentRun.Phase phase, int phaseCount, int phaseIndex, int firstStep) {
        LinearLayout block = new LinearLayout(context);
        block.setOrientation(VERTICAL);
        boolean lifted = phase.running && animate;
        int fill = lifted ? context.getColor(R.color.aether_tool_bg)
                : context.getColor(R.color.aether_field);
        int stroke = lifted ? context.getColor(R.color.aether_accent)
                : context.getColor(R.color.aether_field_border);
        block.setBackground(rounded(fill, 14, stroke, lifted ? 2 : 1));
        // Status is readable without motion: the lifted surface already says
        // "this is the block that is executing".
        block.setElevation(Ui.dp(context, lifted ? 4 : 1));
        block.setClipToPadding(false);
        int pad = Ui.dp(context, 10);
        block.setPadding(pad, Ui.dp(context, 8), pad, Ui.dp(context, 8));

        block.addView(header(phase));
        if (phase.synthetic) {
            TextView note = Ui.tv(context, "Reasoning happens before any tool runs. Private thoughts are never shown.",
                    11, Ui.DIM);
            note.setPadding(Ui.dp(context, 34), Ui.dp(context, 4), 0, Ui.dp(context, 2));
            block.addView(note);
        } else {
            for (int i = 0; i < phase.steps.size(); i++) {
                AgentActivity.Step step = phase.steps.get(i);
                block.addView(stepRow(phase, step, i, firstStep + i));
            }
        }

        LayoutParams lp = new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = phaseIndex == phaseCount - 1 ? 0 : Ui.dp(context, 8);
        block.setLayoutParams(lp);
        if (animate) {
            block.setAlpha(0f);
            block.setTranslationY(Ui.dp(context, 8));
            block.animate().alpha(1f).translationY(0f).setDuration(200).start();
        }
        return block;
    }

    private View header(AgentRun.Phase phase) {
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);

        TextView tile = Ui.tv(context, phase.glyph(), 13, R.color.aether_on_accent);
        tile.setGravity(Gravity.CENTER);
        tile.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable tileBg = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{context.getColor(R.color.aether_accent),
                        context.getColor(R.color.aether_accent_deep)});
        tileBg.setCornerRadius(Ui.dp(context, 9));
        tile.setBackground(tileBg);
        tile.setElevation(Ui.dp(context, 2));
        row.addView(tile, new LayoutParams(Ui.dp(context, 26), Ui.dp(context, 26)));

        TextView title = Ui.tv(context, phase.title(), 12, Ui.PRIMARY);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setPadding(Ui.dp(context, 9), 0, 0, 0);
        title.setMaxLines(1);
        title.setEllipsize(TextUtils.TruncateAt.END);
        row.addView(title, new LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        String count = phase.countLabel();
        if (!count.isEmpty()) {
            TextView chip = Ui.tv(context, count, 10, Ui.DIM);
            chip.setBackground(rounded(context.getColor(R.color.aether_bg), 7,
                    context.getColor(R.color.aether_field_border), 1));
            chip.setPadding(Ui.dp(context, 6), Ui.dp(context, 2), Ui.dp(context, 6), Ui.dp(context, 2));
            row.addView(chip);
        }

        long ms = phase.durationMs();
        if (ms > 0) {
            TextView time = Ui.meta(context, ms < 1000 ? ms + "ms" : (ms / 1000f < 10f
                    ? String.format(Locale.US, "%.1fs", ms / 1000f) : (ms / 1000) + "s"));
            time.setPadding(Ui.dp(context, 8), 0, 0, 0);
            row.addView(time);
        }

        if (phase.running) {
            AgentPulseView pulse = new AgentPulseView(context);
            pulse.setRunning(animate);
            LayoutParams plp = new LayoutParams(Ui.dp(context, 24), Ui.dp(context, 16));
            plp.leftMargin = Ui.dp(context, 8);
            row.addView(pulse, plp);
        }
        return row;
    }

    // ------------------------------------------------------------------- steps

    private View stepRow(AgentRun.Phase phase, AgentActivity.Step step, int indexInPhase, int globalIndex) {
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(HORIZONTAL);

        RailNode rail = new RailNode(context, animate);
        rail.setState(step.done, !step.done, indexInPhase == 0,
                indexInPhase == phase.steps.size() - 1);
        LayoutParams railLp = new LayoutParams(Ui.dp(context, 22), ViewGroup.LayoutParams.MATCH_PARENT);
        railLp.topMargin = Ui.dp(context, 2);
        row.addView(rail, railLp);

        LinearLayout content = new LinearLayout(context);
        content.setOrientation(VERTICAL);
        content.setPadding(Ui.dp(context, 6), 0, 0,
                indexInPhase == phase.steps.size() - 1 ? 0 : Ui.dp(context, 10));

        LinearLayout top = new LinearLayout(context);
        top.setOrientation(HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);

        boolean expanded = openIndex == globalIndex;
        boolean hasDetails = !step.detail.isEmpty() || step.chars > 0
                || (step.source != null && !step.source.isEmpty());

        TextView name = Ui.tv(context, iconFor(step.tool) + "  " + (step.done ? step.past : step.label),
                12, step.done ? Ui.PRIMARY : Ui.ACCENT);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        name.setMaxLines(2);
        name.setEllipsize(TextUtils.TruncateAt.END);
        top.addView(name, new LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        if (step.done && step.durationMs > 0) {
            top.addView(Ui.meta(context, step.durationMs < 1000
                    ? step.durationMs + "ms" : (step.durationMs / 1000) + "s"));
        }
        if (hasDetails) {
            TextView chevron = Ui.meta(context, expanded ? "\u2303" : "\u2304");
            chevron.setPadding(Ui.dp(context, 8), 0, 0, 0);
            top.addView(chevron);
            // Kept identical to the pre-timeline wording so existing
            // accessibility/tests selectors stay valid.
            top.setContentDescription((expanded ? "Collapse " : "Expand ") + step.label);
            top.setOnClickListener(v -> {
                userToggled = true;
                openIndex = openIndex == globalIndex ? -1 : globalIndex;
                rebind();
            });
        }
        content.addView(top);

        if (!step.detail.isEmpty() && !expanded) {
            TextView preview = Ui.tv(context, "run_command".equals(step.tool)
                    ? "$ " + step.detail : step.detail, 11, Ui.DIM);
            if ("run_command".equals(step.tool)) preview.setTypeface(Ui.mono(context));
            preview.setMaxLines(1);
            preview.setEllipsize(TextUtils.TruncateAt.END);
            preview.setPadding(0, Ui.dp(context, 2), 0, 0);
            content.addView(preview);
        }

        if (expanded) {
            LinearLayout well = new LinearLayout(context);
            well.setOrientation(VERTICAL);
            well.setBackground(rounded(context.getColor(R.color.aether_code_bg), 10,
                    context.getColor(R.color.aether_code_border), 1));
            well.setPadding(Ui.dp(context, 10), Ui.dp(context, 8), Ui.dp(context, 10), Ui.dp(context, 8));
            LinearLayout.LayoutParams wlp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            wlp.topMargin = Ui.dp(context, 7);
            if (!step.detail.isEmpty()) {
                TextView detail = Ui.tv(context, "run_command".equals(step.tool)
                        ? "$ " + step.detail : step.detail, 11, Ui.DIM);
                if ("run_command".equals(step.tool)) detail.setTypeface(Ui.mono(context));
                detail.setTextIsSelectable(true);
                well.addView(detail);
            }
            if (step.chars > 0) {
                TextView returned = Ui.meta(context, "Returned " + step.chars + " characters");
                returned.setPadding(0, Ui.dp(context, 5), 0, 0);
                well.addView(returned);
            }
            if (step.source != null && !step.source.isEmpty()) {
                TextView site = Ui.tv(context, "\u2197  " + step.source, 11, Ui.ACCENT);
                site.setPadding(0, Ui.dp(context, 6), 0, 0);
                site.setMaxLines(2);
                site.setEllipsize(TextUtils.TruncateAt.MIDDLE);
                site.setOnClickListener(v -> { if (opener != null) opener.open(step.source); });
                well.addView(site);
            }
            content.addView(well, wlp);
        }

        row.addView(content, new LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        LayoutParams lp = new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        row.setLayoutParams(lp);
        return row;
    }

    /** The last bound run, so expanding one step does not need a round trip. */
    private List<AgentRun.Phase> lastPhases;
    private boolean lastRunning;

    /** Global index of the step that is still running, or -1. */
    private static int runningIndex(List<AgentRun.Phase> phases) {
        int index = 0;
        for (AgentRun.Phase phase : phases) {
            for (AgentActivity.Step step : phase.steps) {
                if (!step.done) return index;
                index++;
            }
        }
        return -1;
    }

    private void rebind() {
        if (lastPhases == null) return;
        List<AgentRun.Phase> phases = lastPhases;
        body.removeAllViews();
        int stepIndex = 0;
        for (int p = 0; p < phases.size(); p++) {
            AgentRun.Phase phase = phases.get(p);
            body.addView(phaseBlock(phase, phases.size(), p, stepIndex));
            stepIndex += phase.total();
        }
    }

    static String iconFor(String tool) {
        if ("web_search".equals(tool)) return "\u2315";
        if ("fetch_page".equals(tool) || "crawl_site".equals(tool) || "browser".equals(tool)) return "\u2197";
        if ("run_command".equals(tool)) return "\u203a";
        if ("generate_image".equals(tool) || "generate_voice".equals(tool)) return "\u2726";
        return "\u2022";
    }

    private GradientDrawable rounded(int fill, int radiusDp, int stroke, int strokeDp) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.RECTANGLE);
        d.setColor(fill);
        d.setCornerRadius(Ui.dp(context, radiusDp));
        d.setStroke(Ui.dp(context, strokeDp), stroke);
        return d;
    }

    /**
     * The node-and-rail column. A finished step is a solid tick on a quiet rail;
     * the executing step breathes, because something is genuinely happening.
     */
    private static final class RailNode extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF oval = new RectF();
        private final boolean animate;
        private boolean done, active, first, last;
        private float pulse;
        private ValueAnimator animator;
        private int lineColor, doneColor, activeColor, idleColor;

        RailNode(Context context, boolean animate) {
            super(context);
            this.animate = animate;
            lineColor = context.getColor(R.color.aether_field_border);
            doneColor = context.getColor(R.color.aether_ok);
            activeColor = context.getColor(R.color.aether_accent);
            idleColor = context.getColor(R.color.aether_field_border);
        }

        void setState(boolean done, boolean active, boolean first, boolean last) {
            this.done = done; this.active = active; this.first = first; this.last = last;
            if (active && animate) start(); else stop();
            invalidate();
        }

        private void start() {
            if (animator != null || getWindowToken() == null) return;
            animator = ValueAnimator.ofFloat(0f, 1f);
            animator.setDuration(1400);
            animator.setRepeatCount(ValueAnimator.INFINITE);
            animator.addUpdateListener(a -> { pulse = (float) a.getAnimatedValue(); invalidate(); });
            animator.start();
        }

        private void stop() {
            if (animator != null) { animator.cancel(); animator = null; }
            pulse = 0f;
        }

        @Override protected void onAttachedToWindow() { super.onAttachedToWindow(); if (active && animate) start(); }

        @Override protected void onDetachedFromWindow() { stop(); super.onDetachedFromWindow(); }

        @Override protected void onDraw(Canvas canvas) {
            float cx = getWidth() / 2f;
            float nodeY = Ui.dp(getContext(), 8);
            float r = Ui.dp(getContext(), 4);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(Ui.dp(getContext(), 1.5f));
            paint.setColor(done ? withAlpha(doneColor, 110) : lineColor);
            if (!first) canvas.drawLine(cx, 0, cx, nodeY - r - 2, paint);
            if (!last) canvas.drawLine(cx, nodeY + r + 2, cx, getHeight(), paint);

            if (active && animate) {
                // Breathing halo: reads as "in progress" from across the room,
                // and implies nothing about a completion percentage.
                paint.setStyle(Paint.Style.FILL);
                paint.setColor(withAlpha(activeColor, (int) (70 * (1f - pulse))));
                oval.set(cx - r - Ui.dp(getContext(), 5) * (1f - pulse),
                        nodeY - r - Ui.dp(getContext(), 5) * (1f - pulse),
                        cx + r + Ui.dp(getContext(), 5) * (1f - pulse),
                        nodeY + r + Ui.dp(getContext(), 5) * (1f - pulse));
                canvas.drawOval(oval, paint);
            }
            paint.setStyle(Paint.Style.FILL);
            paint.setColor(done ? doneColor : active ? activeColor : idleColor);
            canvas.drawCircle(cx, nodeY, r, paint);
            if (done) {
                paint.setColor(Color.WHITE);
                paint.setStrokeWidth(Ui.dp(getContext(), 1.4f));
                paint.setStyle(Paint.Style.STROKE);
                float t = Ui.dp(getContext(), 1.6f);
                canvas.drawLine(cx - t, nodeY, cx - t * .2f, nodeY + t, paint);
                canvas.drawLine(cx - t * .2f, nodeY + t, cx + t * 1.2f, nodeY - t, paint);
            }
        }

        private static int withAlpha(int color, int alpha) {
            return Color.argb(Math.max(0, Math.min(255, alpha)),
                    Color.red(color), Color.green(color), Color.blue(color));
        }
    }
}
