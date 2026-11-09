package com.aether.app;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.UiScrollable;
import androidx.test.uiautomator.UiSelector;
import androidx.test.uiautomator.Until;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;

/** Real emulator navigation and PNG evidence. No live provider/fleet calls are made. */
@RunWith(AndroidJUnit4.class)
public class ScreenshotTest {
    private static final String PKG = "com.aether.app.debug";
    private UiDevice device;
    private File output;
    private int statusBarHeight;
    private int navigationBarHeight;

    @Before public void setUp() throws Exception {
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        statusBarHeight = systemBarHeight(context, "status_bar_height");
        navigationBarHeight = systemBarHeight(context, "navigation_bar_height");
        output = new File(context.getExternalFilesDir(null), "screenshots");
        assertTrue(output.exists() || output.mkdirs());
        AetherPrefs.warmOnLaunch(context, false);       // isolate UI evidence from Kaggle
        AetherPrefs.animations(context, false);        // stable PNGs, motion is source-tested
        AetherPrefs.markDisclaimerSeen(context);
        AetherPrefs.theme(context, "Midnight");
        ByokClient.Connection fixture = new ByokClient.Connection();
        fixture.provider = "openai";
        fixture.name = "Personal OpenAI";
        fixture.baseUrl = "https://api.openai.com/v1";
        fixture.defaultModel = "gpt-4.1-mini";
        fixture.models.add("gpt-4.1-mini");
        fixture.models.add("gpt-4o-mini");
        fixture.apiKey = "screenshot-fixture-not-a-real-key";
        fixture.testStatus = "";                       // deliberately not verified
        new ByokStore(context).save(fixture);
        device.pressHome();
        device.waitForIdle();
    }

    @Test public void captureAetherProduct() throws Exception {
        ActivityScenario<ChatActivity> scenario = ActivityScenario.launch(ChatActivity.class);
        scenario.onActivity(activity -> { });
        assertVisible("welcome to aether,");
        assertClearOfSystemBars("workspace_btn", true);
        assertClearOfSystemBars("send_btn", false);
        shot("01-chat-welcome");

        openWorkspace();
        assertVisible("Inspect and edit the files your Agent creates");
        shot("02-workspace-files");
        device.pressBack();
        device.waitForIdle();

        openHistory();
        assertVisible("Sign in or create account");
        assertVisible("Settings");
        shot("03-history-account-settings");
        clickId("account_btn");
        assertVisible("Your Aether account");
        assertVisible("Continue with Google");
        shot("04-account-auth");
        device.pressBack();
        device.waitForIdle();
        if (device.findObject(By.textContains("RECENT CHATS")) != null) {
            device.pressBack();
            device.waitForIdle();
        }

        clickId("model_selector");
        assertVisible("Choose your model");
        assertVisible("Personal OpenAI");
        shot("05-model-picker");
        clickText("Aether Uncensored", true);
        assertVisible("Your responsibility with Aether Uncensored");
        assertVisible("You are responsible for reviewing outputs, commands and files");
        shot("05b-uncensored-responsibility");
        clickText("CANCEL");
        clickText("Personal OpenAI");
        clickText("gpt-4o-mini");
        assertVisible("gpt-4o-mini");

        clickId("mode_discuss");
        assertVisible("Fast conversation · search, fetch and crawl");
        shot("06-discussion-composer");
        clickId("mode_agent");
        clickId("attach_btn");
        assertVisible("Upload an image");
        assertVisible("Attach a file");
        assertTrue("Plus menu exposes uploads only", device.findObject(By.textContains("Connectors & MCP")) == null
                && device.findObject(By.textContains("Auto-run Agent commands")) == null);
        shot("07-agent-plus-menu");
        device.pressBack();
        openHistory();
        clickId("drawer_connectors_btn");
        assertVisible("GitHub");
        shot("08-connector-catalog");
        scrollTo("Custom MCP server");
        assertVisible("Custom MCP server");
        scrollTo("GitHub");
        clickText("GitHub", true);
        assertVisible("Read/search tools");
        assertVisible("Create/edit tools");
        assertVisible("Execute/workflow tools");
        shot("09-github-permissions");
        device.pressBack();
        device.pressBack();
        device.waitForIdle();
        openHistory();
        clickId("drawer_settings_btn");
        assertClearOfSystemBars("back_btn", true);
        assertVisible("Make Aether work the way you do.");
        shot("10-settings-home");

        clickText("Models");
        assertVisible("One clear choice for every conversation.");
        shot("11-settings-models");
        device.pressBack();

        clickText("Personal Providers");
        assertVisible("Your keys. Your models. Direct connections.");
        assertVisible("Personal OpenAI");
        shot("12-settings-providers");
        device.pressBack();

        clickText("Appearance");
        assertVisible("A calm interface, tuned to you.");
        shot("13-settings-appearance");
        clickText("App theme");
        clickText("Light");
        assertVisible("Make Aether work the way you do.");
        shot("14-settings-light");

        clickText("Appearance");
        clickText("App theme");
        clickText("Midnight");
        assertVisible("Make Aether work the way you do.");

        scrollTo("Legal & Policies");
        clickText("Legal & Policies");
        assertVisible("Plain language for adult, responsible use.");
        shot("15-settings-legal");
        clickText("Privacy Policy");
        assertVisible("PRIVACY POLICY");
        shot("16-privacy-policy");
        device.pressBack();              // legal list
        assertVisible("Plain language for adult, responsible use.");
        device.pressBack();              // settings home
        device.pressBack();              // chat

        final Object[] fixturePanel = new Object[1];
        scenario.onActivity(activity -> {
            try {
                Method add = ChatActivity.class.getDeclaredMethod("addAssistantBubble");
                add.setAccessible(true);
                Object bubble = add.invoke(activity);
                Field panelField = bubble.getClass().getDeclaredField("activity");
                panelField.setAccessible(true);
                Object panel = panelField.get(bubble);
                fixturePanel[0] = panel;
                Method event = panel.getClass().getDeclaredMethod("event", String.class);
                event.setAccessible(true);
                // Recorded engine events from scripts/proofs/output/real-agent-events.ndjson.
                event.invoke(panel, "⚙️ agent step 1...");
                event.invoke(panel, "🛠️ web_search({\"query\": \"Nigeria top news headline today\"})");
                event.invoke(panel, "↳ web_search returned 1204 chars");
                event.invoke(panel, "🛠️ fetch_page({\"url\": \"https://www.premiumtimesng.com/\"})");
                event.invoke(panel, "↳ fetch_page returned 12045 chars");
                event.invoke(panel, "🛠️ run_command({\"command\": \"pwd\"})");
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        device.waitForIdle();
        assertVisible("$ pwd");
        shot("17-activity-command-open");
        scenario.onActivity(activity -> {
            try {
                Object panel = fixturePanel[0];
                Method event = panel.getClass().getDeclaredMethod("event", String.class);
                event.setAccessible(true);
                event.invoke(panel, "↳ run_command returned 24 chars");
                Field report = panel.getClass().getDeclaredField("report"); report.setAccessible(true);
                report.set(panel, "Status: Finished\n3 steps · workspace checkpoint saved");
                // The turn has to end before the collapsed line reports what
                // happened; while it runs the same card correctly says "Thinking".
                Method finish = panel.getClass().getDeclaredMethod("finish"); finish.setAccessible(true); finish.invoke(panel);
            } catch (Exception e) { throw new RuntimeException(e); }
        });
        device.waitForIdle();
        // Folded means the panel itself hides its detail list. Reading the whole
        // window instead would also match any earlier bubble still on screen.
        boolean[] folded = new boolean[1];
        scenario.onActivity(activity -> {
            try {
                Object panel = fixturePanel[0];
                Field expanded = panel.getClass().getDeclaredField("expanded"); expanded.setAccessible(true);
                Field listField = panel.getClass().getDeclaredField("list"); listField.setAccessible(true);
                android.view.View list = (android.view.View) listField.get(panel);
                folded[0] = !expanded.getBoolean(panel) && list.getVisibility() == android.view.View.GONE;
            } catch (Exception e) { throw new RuntimeException(e); }
        });
        assertTrue("Completed command did not fold automatically", folded[0]);
        // Nothing but the collapsed line is showing yet.
        assertTrue("Collapsed line did not name the command", device.findObject(By.textContains("Ran a command")) != null);
        // Tapping the collapsed line re-opens the panel; the summary is the
        // evidence that the real detail list came back.
        clickText("Ran a command", true);
        assertVisible("TASK SUMMARY");
        shot("18-activity-command-summary");
        // A finished step's detail sits behind its own row control, so the
        // command text is reached by expanding that row, not by the panel.
        UiObject2 row = device.wait(Until.findObject(By.desc("Expand Ran a command")), 6000);
        assertNotNull("Finished command row has no expander", row);
        row.click();
        device.waitForIdle();
        assertVisible("$ pwd");
        shot("18b-activity-command-detail");
        device.waitForIdle();

        scenario.onActivity(activity -> {
            try {
                org.json.JSONObject payload = new org.json.JSONObject();
                org.json.JSONArray items = new org.json.JSONArray();
                items.put(new org.json.JSONObject().put("id", "target").put("text", "Which target should I build?").put("options", new org.json.JSONArray().put("Android").put("Web")));
                items.put(new org.json.JSONObject().put("id", "release").put("text", "Which release should I prepare?").put("options", new org.json.JSONArray().put("Debug").put("Production")));
                items.put(new org.json.JSONObject().put("id", "confirm").put("text", "Ready to continue?").put("options", new org.json.JSONArray().put("Yes").put("Not yet")));
                payload.put("items", items);
                Method questions = ChatActivity.class.getDeclaredMethod("showAgentQuestions", org.json.JSONObject.class);
                questions.setAccessible(true); questions.invoke(activity, payload);
            } catch (Exception e) { throw new RuntimeException(e); }
        });
        assertVisible("AGENT QUESTION · 1 OF 3");
        shot("19-agent-question-first");
        clickText("Android", true);
        clickText("Submit", true);
        assertVisible("AGENT QUESTION · 2 OF 3");
        assertVisible("Which release should I prepare?");
        shot("20-agent-question-second");
        clickText("Skip", true);
        assertVisible("AGENT QUESTION · 3 OF 3");

        clickId("input");
        UiObject2 composerInput = device.wait(Until.findObject(By.res(PKG + ":id/input")), 5_000);
        assertNotNull(composerInput);
        composerInput.setText("Keyboard keeps the composer visible");
        device.waitForIdle();
        shot("21-keyboard-open");
        assertClearOfSystemBars("send_btn", false);
        assertAboveKeyboard(scenario);
        device.pressBack();
        device.waitForIdle();

        openHistory();
        clickId("new_chat_btn");
        assertVisible("welcome to aether,");
        shot("22-new-chat-welcome");
        writeManifest();
        scenario.close();
    }

    @Test public void captureBackupSignedOut() {
        ActivityScenario<BackupActivity> scenario = ActivityScenario.launch(BackupActivity.class);
        assertVisible("Backup & restore");
        assertVisible("Sign in to your Aether account before connecting backup.");
        shot("04b-backup-signed-out");
        scenario.close();
    }

    private void assertAboveKeyboard(ActivityScenario<ChatActivity> scenario) {
        final int[] imeBottom = {0};
        scenario.onActivity(activity -> {
            androidx.core.view.WindowInsetsCompat insets = androidx.core.view.ViewCompat.getRootWindowInsets(activity.getWindow().getDecorView());
            if (insets != null) imeBottom[0] = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime()).bottom;
        });
        UiObject2 send = device.wait(Until.findObject(By.res(PKG + ":id/send_btn")), 5_000);
        assertNotNull(send);
        assertTrue("Keyboard was not open during keyboard evidence", imeBottom[0] > 0);
        assertTrue("Composer is covered by the IME: send bottom=" + send.getVisibleBounds().bottom
                        + ", ime inset=" + imeBottom[0],
                send.getVisibleBounds().bottom <= device.getDisplayHeight() - imeBottom[0] + 2);
    }

    private int systemBarHeight(Context context, String name) {
        int resource = context.getResources().getIdentifier(name, "dimen", "android");
        assertTrue("Missing Android system-bar dimension: " + name, resource > 0);
        return context.getResources().getDimensionPixelSize(resource);
    }

    private void assertClearOfSystemBars(String id, boolean topEdge) {
        UiObject2 object = device.wait(Until.findObject(By.res(PKG + ":id/" + id)), 6_000);
        assertNotNull("Missing view for system-bar bounds check: " + id, object);
        boolean clear = false;
        for (int attempt = 0; attempt < 40 && !clear; attempt++) {
            object = device.findObject(By.res(PKG + ":id/" + id));
            if (object != null) {
                clear = topEdge ? object.getVisibleBounds().top >= statusBarHeight
                        : object.getVisibleBounds().bottom <= device.getDisplayHeight() - navigationBarHeight;
            }
            if (!clear) android.os.SystemClock.sleep(100);
        }
        if (!clear) shot("bounds-failure-" + id);
        assertNotNull("View disappeared during bounds check: " + id, object);
        if (topEdge) {
            assertTrue(id + " is underneath the status bar after waiting for decor insets: top="
                            + object.getVisibleBounds().top + ", required=" + statusBarHeight,
                    object.getVisibleBounds().top >= statusBarHeight);
        } else {
            assertTrue(id + " is underneath the navigation bar after waiting for decor insets",
                    object.getVisibleBounds().bottom <= device.getDisplayHeight() - navigationBarHeight);
        }
    }

    private void openWorkspace() throws Exception {
        UiObject2 workspace = null;
        // A freshly captured software-rendered frame can occasionally drop the first tap.
        // Retry the real view interaction; never open the drawer through reflection.
        for (int attempt = 0; attempt < 3 && workspace == null; attempt++) {
            clickId("workspace_btn");
            workspace = device.wait(Until.findObject(By.text("Workspace")), 3_000);
        }
        if (workspace == null) {
            shot("workspace-failure");
            device.dumpWindowHierarchy(new File(output, "workspace-failure-hierarchy.xml"));
        }
        assertNotNull("Workspace screen did not open after three real taps", workspace);
        device.waitForIdle();
    }

    private void clickId(String id) {
        UiObject2 object = device.wait(Until.findObject(By.res(PKG + ":id/" + id)), 6_000);
        assertNotNull("Missing view " + id, object);
        object.click();
        device.waitForIdle();
    }

    private void clickText(String text) { clickText(text, false); }

    private void clickText(String text, boolean contains) {
        UiObject2 object = device.wait(Until.findObject(contains ? By.textContains(text) : By.text(text)), 6_000);
        assertNotNull("Missing text " + text, object);
        object.click();
        device.waitForIdle();
    }

    private void openHistory() {
        clickId("menu_btn");
        assertVisible("RECENT CHATS");
        device.waitForIdle();
    }

    private void assertVisible(String text) {
        UiObject2 object = device.wait(Until.findObject(By.textContains(text)), 7_000);
        assertNotNull("Expected visible text: " + text, object);
    }

    private void scrollTo(String text) throws Exception {
        UiScrollable scrollable = new UiScrollable(new UiSelector().scrollable(true));
        scrollable.scrollIntoView(new UiSelector().text(text));
    }

    private void shot(String name) {
        device.waitForIdle();
        File file = new File(output, name + ".png");
        assertTrue("Screenshot failed: " + name, device.takeScreenshot(file));
        assertTrue("Empty screenshot: " + name, file.length() > 10_000);
    }

    private void writeManifest() throws Exception {
        String json = "{\n"
                + "  \"device\": \"GitHub Actions Android emulator\",\n"
                + "  \"navigation\": \"instrumented APK UI\",\n"
                + "  \"liveProviderConnectivity\": false,\n"
                + "  \"liveFleetConnectivity\": false,\n"
                + "  \"liveAuth\": false,\n"
                + "  \"liveDrive\": false,\n"
                + "  \"liveMcp\": false,\n"
                + "  \"personalProvider\": \"local, unverified screenshot fixture; no real key\",\n"
                + "  \"activityScreenshot\": \"recorded engine-event and structured-question fixtures, not a live turn\",\n"
                + "  \"screenshots\": 22\n"
                + "}";
        try (FileOutputStream out = new FileOutputStream(new File(output, "verification.json"))) {
            out.write(json.getBytes(StandardCharsets.UTF_8));
        }
    }
}
