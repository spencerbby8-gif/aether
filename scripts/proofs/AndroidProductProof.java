import java.nio.file.Files;
import java.nio.file.Paths;
import java.nio.charset.StandardCharsets;

/** Static product-contract checks. These are not emulator or live-engine results. */
public final class AndroidProductProof {
    private static int pass, fail;
    private static void check(String name, boolean ok, String detail) {
        System.out.println((ok ? "  PASS  " : "  FAIL  ") + name + "  [" + detail + "]");
        if (ok) pass++; else fail++;
    }
    private static String read(String path) {
        try { return new String(Files.readAllBytes(Paths.get(path)), StandardCharsets.UTF_8); }
        catch (Exception e) { return ""; }
    }
    private static int count(String text, String needle) {
        int n = 0, at = 0;
        while ((at = text.indexOf(needle, at)) >= 0) { n++; at += needle.length(); }
        return n;
    }

    public static void main(String[] args) {
        String chat = read("android/app/src/main/java/com/aether/app/ChatActivity.java");
        String settings = read("android/app/src/main/java/com/aether/app/SettingsActivity.java");
        String chatXml = read("android/app/src/main/res/layout/activity_chat.xml");
        String settingsXml = read("android/app/src/main/res/layout/activity_settings.xml");
        String picker = read("android/app/src/main/java/com/aether/app/ModelPickerDialog.java");
        String legal = read("android/app/src/main/java/com/aether/app/LegalText.java");

        check("settings opens a category overview first", settings.contains("if (requested == null) showHome()")
                && count(settings, "new Destination(") >= 11, count(settings, "new Destination(") + " destinations");
        check("every category uses a focused subscreen", settings.contains("void showSection(String id)")
                && settingsXml.contains("settings_content"), "navigation host present");
        check("workspace and settings are separate header destinations", chatXml.contains("workspace_btn")
                && chatXml.contains("settings_btn") && chatXml.contains("ic_workspace"), "top-right actions");
        check("the large welcome belongs to every empty chat", chatXml.contains("welcome to aether,\\nwhat are we doing today?")
                && chat.contains("showEmptyState()") && chat.contains("welcome_panel"), "welcome panel");
        check("the taller composer contains model and discussion controls", chatXml.contains("minHeight=\"74dp\"")
                && chatXml.contains("model_selector") && chatXml.contains("mode_agent")
                && chatXml.contains("mode_discuss"), "embedded composer controls");
        check("model selection is an elevated bottom sheet", picker.contains("Gravity.BOTTOM")
                && picker.contains("bg_model_selected") && picker.contains("AetherSheetAnimation"), "custom sheet");
        check("chat sends the selected discussion mode", chat.contains("discussion, cancel")
                && chat.contains("discussionInstructions"), "request plumbing");
        String notebook = read("android/app/src/main/assets/aether-notebook-template.json");
        check("the engine removes tool calling in discussion", notebook.contains("([] if discussion else TOOLS)")
                && notebook.contains("tcs = [] if discussion") && notebook.contains("DISCUSSION MODE"), "hard per-turn tool boundary");
        check("launch warm-up is shared and parallel", chat.contains("FleetWarmup.warmAll")
                && read("android/app/src/main/java/com/aether/app/SplashActivity.java").contains("FleetWarmup.warmAll")
                && read("android/app/src/main/java/com/aether/app/FleetWarmup.java").contains("newFixedThreadPool"), "process-wide coordinator");
        check("legal documents cover the required boundaries", legal.contains("DISCLAIMER")
                && legal.contains("TERMS") && legal.contains("PRIVACY") && legal.contains("CONTENT")
                && legal.contains("Android Keystore"), "disclaimer, terms, privacy, responsibility");
        check("no individual fleet labels appear in screen layouts", !chatXml.matches("(?s).*Engine [A-D].*")
                && !settingsXml.matches("(?s).*Engine [A-D].*") && !settingsXml.contains("routing_rows"), "unified public UI");
        check("old generic empty-state copy is gone", !chat.contains("Ask Aether anything")
                && !chat.contains("chat, tools, search, commands"), "product language");

        System.out.println("\nANDROID PRODUCT PROOF  " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }
}
