package com.aether.app;

import android.animation.ValueAnimator;
import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.AccelerateDecelerateInterpolator;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.OvershootInterpolator;
import android.widget.ImageView;
import android.widget.TextView;

/**
 * Opening animation.
 *
 * WHAT IT IS. The Aether mark scales in on an overshoot, a ring pulses out from
 * behind it, the wordmark settles from wide letter-spacing to its resting
 * tracking, an accent rule draws itself, and the tagline fades in. Then the app
 * hands over to the chat. It is 900 ms, which is long enough to read as a title
 * card and short enough that nobody waits on it.
 *
 * WHAT IT IS NOT. It is not a loading screen and it fakes no work: nothing here
 * stands in for engine activity, because the chat screen reports only what the
 * engines actually stream. If the user has turned animations off system-wide,
 * the whole thing is skipped and the chat opens immediately.
 */
public class SplashActivity extends Activity {

    private static final long HANDOVER_MS = 900;

    private final Handler hand = new Handler(Looper.getMainLooper());
    private boolean handedOver;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_splash);

        if (animationsDisabled()) {
            go();
            return;
        }

        View ring = findViewById(R.id.splash_ring);
        ImageView logo = findViewById(R.id.splash_logo);
        TextView word = findViewById(R.id.splash_word);
        View line = findViewById(R.id.splash_line);
        TextView sub = findViewById(R.id.splash_sub);

        /* Mark: in fast, past its resting size, settling back. */
        logo.animate().alpha(1f).setDuration(200).start();
        logo.setScaleX(0.62f);
        logo.setScaleY(0.62f);
        logo.animate().scaleX(1f).scaleY(1f).setDuration(430)
                .setInterpolator(new OvershootInterpolator(1.7f)).start();

        /* Ring: one pulse outward from behind the mark. */
        ring.setAlpha(0.85f);
        ring.setScaleX(0.55f);
        ring.setScaleY(0.55f);
        ring.animate().scaleX(1.45f).scaleY(1.45f).alpha(0f)
                .setStartDelay(140).setDuration(620)
                .setInterpolator(new DecelerateInterpolator(1.6f)).start();

        /* Wordmark: tracking closes as it fades in. */
        word.animate().alpha(1f).setStartDelay(210).setDuration(260).start();
        ValueAnimator spacing = ValueAnimator.ofFloat(0.58f, 0.2f);
        spacing.setStartDelay(210);
        spacing.setDuration(520);
        spacing.setInterpolator(new DecelerateInterpolator(1.4f));
        spacing.addUpdateListener(a -> word.setLetterSpacing((Float) a.getAnimatedValue()));
        spacing.start();

        /* Accent rule: draws itself under the wordmark. */
        final int full = Math.round(72 * getResources().getDisplayMetrics().density);
        ValueAnimator draw = ValueAnimator.ofInt(0, full);
        draw.setStartDelay(370);
        draw.setDuration(380);
        draw.setInterpolator(new AccelerateDecelerateInterpolator());
        draw.addUpdateListener(a -> {
            ViewGroup.LayoutParams lp = line.getLayoutParams();
            lp.width = (Integer) a.getAnimatedValue();
            line.setLayoutParams(lp);
        });
        draw.start();

        sub.animate().alpha(1f).setStartDelay(560).setDuration(240).start();

        hand.postDelayed(this::go, HANDOVER_MS);
    }

    /** Honour the system-wide "animations are off" setting. */
    private boolean animationsDisabled() {
        try {
            float scale = Settings.Global.getFloat(getContentResolver(),
                    Settings.Global.ANIMATOR_DURATION_SCALE, 1f);
            return scale == 0f;
        } catch (Exception e) {
            return false;
        }
    }

    private void go() {
        if (handedOver) return;
        handedOver = true;
        startActivity(new Intent(this, ChatActivity.class));
        finish();
        overridePendingTransition(0, 0);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        /* Stop the timer; never launch from here -- if we are being destroyed
           the user backed out or the process is going away. */
        hand.removeCallbacksAndMessages(null);
    }
}
