package com.aether.app;

import java.util.ArrayList;
import java.util.List;

/**
 * A/B/C routing.
 *
 * Two separate questions, deliberately not conflated:
 *
 *   SELECTION  -- which engine the user wants. AUTO, or a manual A / B / C pin.
 *   LIVE       -- which engines can actually serve right now.
 *
 * Keeping them apart is the whole point. A manual pin on B must still show B as
 * off when B is off, rather than silently talking to A; and AUTO must be free to
 * move when the engine it chose dies. An app that collapses the two either lies
 * about which engine answered, or refuses to fail over.
 *
 * Failover order is A -> B -> C and applies only to AUTO. A manual pin is a pin:
 * if that engine is unavailable the caller is told, and is not quietly re-routed
 * onto someone else's quota.
 *
 * Quota-blocked and unreachable route the same way -- both mean "cannot serve" --
 * but the reason is kept so the UI can say which it was.
 */
public final class EngineRouter {

    public static final String AUTO = "auto";

    /** Canonical failover order. */
    private static final String[] ORDER = {"a", "b", "c"};

    private EngineRouter() {}

    /** Snapshot of one engine's state, as resolved by the console. */
    public static final class SlotState {
        public final String slot;
        public final boolean live;
        public final String url;         // non-null only when live
        public final String reason;      // why it is not live, when it is not
        public final int healthStatus;

        public SlotState(String slot, boolean live, String url, String reason, int healthStatus) {
            this.slot = slot; this.live = live; this.url = url;
            this.reason = reason; this.healthStatus = healthStatus;
        }
    }

    /** The routing decision, with the reason it was made. */
    public static final class Decision {
        public final String slot;        // null when nothing can serve
        public final String url;
        public final String reason;
        public final boolean failedOver;

        Decision(String slot, String url, String reason, boolean failedOver) {
            this.slot = slot; this.url = url; this.reason = reason; this.failedOver = failedOver;
        }

        public boolean ok() { return slot != null; }

        @Override public String toString() {
            return ok() ? (slot.toUpperCase() + " (" + reason + ")") : ("none -- " + reason);
        }
    }

    private static SlotState find(List<SlotState> states, String slot) {
        for (SlotState s : states) if (s.slot.equals(slot)) return s;
        return null;
    }

    /**
     * Choose an engine.
     *
     * @param selection AUTO, or "a"/"b"/"c" to pin one engine
     * @param states    every engine's current state
     */
    public static Decision route(String selection, List<SlotState> states) {
        if (states == null || states.isEmpty()) {
            return new Decision(null, null, "no engines configured", false);
        }

        // ---- manual pin: that engine or nothing --------------------------
        if (selection != null && !selection.isEmpty() && !AUTO.equals(selection)) {
            SlotState s = find(states, selection);
            if (s == null) {
                return new Decision(null, null,
                        "engine " + selection.toUpperCase() + " is not configured", false);
            }
            if (s.live) return new Decision(s.slot, s.url, "manual pin", false);
            return new Decision(null, null,
                    "engine " + selection.toUpperCase() + " is not live (" + s.reason + ")", false);
        }

        // ---- AUTO: first healthy in A -> B -> C --------------------------
        for (String slot : ORDER) {
            SlotState s = find(states, slot);
            if (s == null || !s.live) continue;
            /* "Healthiest" means earliest in A -> B -> C among the live ones. All
               three run the same model on the same GPU class, so there is no
               throughput signal worth preferring, and a deterministic order is
               worth more than a guess because it makes failover predictable and
               testable. If the engines ever differ, this is the one place to
               change. */
            return new Decision(s.slot, s.url, "auto: first healthy in A→B→C", false);
        }

        // ---- nothing live: explain, per engine ---------------------------
        StringBuilder why = new StringBuilder("no engine is live");
        List<String> blocked = new ArrayList<>();
        for (String slot : ORDER) {
            SlotState s = find(states, slot);
            if (s != null) blocked.add(slot.toUpperCase() + ": " + s.reason);
        }
        if (!blocked.isEmpty()) why.append(" -- ").append(String.join("; ", blocked));
        return new Decision(null, null, why.toString(), false);
    }

    /**
     * Where to go if the current engine stops serving. Used both to show the
     * failover target before it is needed and to perform the switch when a
     * request fails. Wraps around, so pinning C still fails over to A.
     */
    public static Decision failoverFrom(String currentSlot, List<SlotState> states) {
        for (String slot : ORDER) {
            if (slot.equals(currentSlot)) continue;
            SlotState s = find(states, slot);
            if (s != null && s.live) {
                return new Decision(s.slot, s.url,
                        "failover from " + currentSlot.toUpperCase(), true);
            }
        }
        return new Decision(null, null, "no other engine is live", false);
    }
}
