import com.aether.app.EngineRouter;
import com.aether.app.EngineRouter.Decision;
import com.aether.app.EngineRouter.SlotState;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * JVM check of the REAL routing class the APK ships
 * (android/app/src/main/java/com/aether/app/EngineRouter.java).
 *
 * This is not a re-implementation: it imports the shipped class and asserts on
 * the decisions it returns. It covers the routing contract the chat screen
 * depends on -- AUTO picks the healthiest live engine in A->B->C, a manual pin
 * uses that engine or refuses, failover walks A->B->C and wraps around.
 */
public final class RouterCheck {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        SlotState aLive = new SlotState("a", true, "https://a.example", null, 200);
        SlotState bLive = new SlotState("b", true, "https://b.example", null, 200);
        SlotState cLive = new SlotState("c", true, "https://c.example", null, 200);
        SlotState aDown = new SlotState("a", false, null, "kernel off", 503);
        SlotState bDown = new SlotState("b", false, null, "tunnel 530", 530);
        SlotState cDown = new SlotState("c", false, null, "never woken", 503);

        List<SlotState> allLive = Arrays.asList(aLive, bLive, cLive);
        List<SlotState> bOnly = Arrays.asList(aDown, bLive, cDown);
        List<SlotState> cOnly = Arrays.asList(aDown, bDown, cLive);
        List<SlotState> none = Arrays.asList(aDown, bDown, cDown);

        // AUTO: deterministic A -> B -> C among the live ones
        Decision d = EngineRouter.route("AUTO", allLive);
        check("AUTO with all live picks A", d.ok() && "a".equals(d.slot) && !d.failedOver, d);

        d = EngineRouter.route("AUTO", bOnly);
        check("AUTO skips dead A, picks B", d.ok() && "b".equals(d.slot), d);

        d = EngineRouter.route("AUTO", cOnly);
        check("AUTO skips dead A and B, picks C", d.ok() && "c".equals(d.slot), d);

        d = EngineRouter.route("AUTO", none);
        check("AUTO with nothing live refuses and names every engine",
                !d.ok() && d.reason.contains("A:") && d.reason.contains("B:")
                        && d.reason.contains("C:"), d);

        // manual pin: that engine only, never a silent hop
        d = EngineRouter.route("b", allLive);
        check("pin B uses B even when A is live", d.ok() && "b".equals(d.slot), d);

        d = EngineRouter.route("a", bOnly);
        check("pin A refuses when A is down (no silent hop to B)",
                !d.ok() && d.reason.contains("A is not live"), d);

        d = EngineRouter.route("z", allLive);
        check("pin on unknown slot is explained, not guessed", !d.ok(), d);

        // failover walks the order and wraps
        d = EngineRouter.failoverFrom("a", allLive);
        check("failover from A lands on B and is flagged",
                d.ok() && "b".equals(d.slot) && d.failedOver, d);

        d = EngineRouter.failoverFrom("c", Arrays.asList(aLive, bDown, cDown));
        check("failover from C wraps to A", d.ok() && "a".equals(d.slot) && d.failedOver, d);

        d = EngineRouter.failoverFrom("a", Arrays.asList(aDown, bDown, cDown));
        check("failover with nothing else live refuses", !d.ok(), d);

        d = EngineRouter.route("AUTO", new ArrayList<SlotState>());
        check("no engines configured refuses cleanly", !d.ok(), d);

        /* Casing must not change routing. The screens display "AUTO" / "A",
           preferences store lower case, and an old or hand-edited value can
           arrive either way. Before normalisation, "AUTO" became a pin on an
           engine called AUTO and refused with "engine AUTO is not configured". */
        d = EngineRouter.route("AUTO", allLive);
        check("upper-case AUTO still routes (was a dead pin)",
                d.ok() && "a".equals(d.slot), d);

        d = EngineRouter.route(" Auto ", bOnly);
        check("padded mixed-case AUTO still routes", d.ok() && "b".equals(d.slot), d);

        d = EngineRouter.route("B", allLive);
        check("upper-case pin B still pins B", d.ok() && "b".equals(d.slot), d);

        d = EngineRouter.route(null, allLive);
        check("null selection means AUTO", d.ok() && "a".equals(d.slot), d);

        d = EngineRouter.route("", cOnly);
        check("blank selection means AUTO", d.ok() && "c".equals(d.slot), d);

        d = EngineRouter.failoverFrom("A", allLive);
        check("upper-case failover source resolves", d.ok() && "b".equals(d.slot), d);

        check("isAuto is case-insensitive",
                EngineRouter.isAuto("AUTO") && EngineRouter.isAuto(" auto ")
                        && EngineRouter.isAuto(null) && !EngineRouter.isAuto("b"), null);

        check("canonical lower-cases and defaults to AUTO",
                EngineRouter.canonical("B").equals("b") && EngineRouter.canonical("AUTO").equals("auto"),
                null);

        System.out.println();
        System.out.println("ROUTER CHECK  " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    private static void check(String name, boolean ok, Decision d) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + name + "  ->  " + d);
        if (ok) pass++; else fail++;
    }
}
