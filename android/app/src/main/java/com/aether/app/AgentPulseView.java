package com.aether.app;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;
import android.view.animation.LinearInterpolator;

/** Three rising bars: a small, honest "work is active" indicator, not fake progress. */
final class AgentPulseView extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF bar = new RectF();
    private ValueAnimator animator;
    private float phase;
    private boolean running;

    AgentPulseView(Context context) {
        super(context);
        paint.setColor(context.getColor(Ui.ACCENT));
        setContentDescription("Agent activity indicator");
    }

    void setRunning(boolean value) {
        if (running == value) return;
        running = value;
        if (value) start();
        else stop();
    }

    private void start() {
        if (animator != null || getWindowToken() == null) return;
        animator = ValueAnimator.ofFloat(0f, 1f);
        animator.setDuration(900);
        animator.setRepeatCount(ValueAnimator.INFINITE);
        animator.setInterpolator(new LinearInterpolator());
        animator.addUpdateListener(animation -> {
            phase = (float) animation.getAnimatedValue();
            invalidate();
        });
        animator.start();
    }

    private void stop() {
        if (animator != null) {
            animator.cancel();
            animator = null;
        }
        phase = 0f;
        invalidate();
    }

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if (running) start();
    }

    @Override protected void onDetachedFromWindow() {
        stop();
        super.onDetachedFromWindow();
    }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float unit = getHeight() / 24f;
        float width = 4f * unit;
        float gap = 3f * unit;
        float total = width * 3f + gap * 2f;
        float left = (getWidth() - total) / 2f;
        float baseline = getHeight() - 2f * unit;
        for (int i = 0; i < 3; i++) {
            double wave = (Math.sin((phase * Math.PI * 2.0) - i * 0.85) + 1.0) / 2.0;
            float height = (6f + (float) wave * 14f) * unit;
            float x = left + i * (width + gap);
            paint.setAlpha(running ? 140 + (int) (wave * 115.0) : 150);
            bar.set(x, baseline - height, x + width, baseline);
            canvas.drawRoundRect(bar, width / 2f, width / 2f, paint);
        }
    }
}
