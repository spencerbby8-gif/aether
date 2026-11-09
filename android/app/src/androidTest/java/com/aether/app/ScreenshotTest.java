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

    @Before public void setUp() throws Exception {
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
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
        assertVisible("Welcome to Aether,");
        shot("01-chat-welcome");

        clickId("workspace_btn");
        assertVisible("Workspace");
        shot("02-workspace");
        device.pressBack();
        device.waitForIdle();

        clickId("model_selector");
        assertVisible("Choose your model");
        assertVisible("Personal OpenAI");
        shot("03-model-picker");
        device.pressBack();

        clickId("mode_discuss");
        assertVisible("Conversation only · no tools");
        shot("04-discussion-composer");

        clickId("settings_btn");
        assertVisible("Make Aether work the way you do.");
        shot("05-settings-home");

        clickText("Models");
        assertVisible("One clear choice for every conversation.");
        shot("06-settings-models");
        device.pressBack();

        clickText("Personal Providers");
        assertVisible("Your keys. Your models. Direct connections.");
        assertVisible("Personal OpenAI");
        shot("07-settings-providers");
        device.pressBack();

        clickText("Appearance");
        assertVisible("A calm interface, tuned to you.");
        shot("08-settings-appearance");
        clickText("App theme");
        clickText("Light");
        assertVisible("Make Aether work the way you do.");
        shot("09-settings-light");

        clickText("Appearance");
        clickText("App theme");
        clickText("Midnight");
        assertVisible("Make Aether work the way you do.");

        scrollTo("Legal & Policies");
        clickText("Legal & Policies");
        assertVisible("Plain language for adult, responsible use.");
        shot("10-settings-legal");
        clickText("Privacy Policy");
        assertVisible("PRIVACY POLICY");
        shot("11-privacy-policy");
        device.pressBack();              // legal list
        device.pressBack();              // settings home
        device.pressBack();              // chat

        scenario.onActivity(activity -> {
            try {
                Method add = ChatActivity.class.getDeclaredMethod("addAssistantBubble");
                add.setAccessible(true);
                Object bubble = add.invoke(activity);
                Field panelField = bubble.getClass().getDeclaredField("activity");
                panelField.setAccessible(true);
                Object panel = panelField.get(bubble);
                Method event = panel.getClass().getDeclaredMethod("event", String.class);
                event.setAccessible(true);
                // Recorded engine events from scripts/proofs/output/real-agent-events.ndjson.
                event.invoke(panel, "⚙️ agent step 1...");
                event.invoke(panel, "🛠️ web_search({\"query\": \"Nigeria top news headline today\"})");
                event.invoke(panel, "↳ web_search returned 1204 chars");
                event.invoke(panel, "🛠️ fetch_page({\"url\": \"https://www.premiumtimesng.com/\"})");
                event.invoke(panel, "↳ fetch_page returned 12045 chars");
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        device.waitForIdle();
        assertVisible("Reading a source");
        shot("12-activity-recorded-fixture");
        writeManifest();
        scenario.close();
    }

    private void clickId(String id) {
        UiObject2 object = device.wait(Until.findObject(By.res(PKG + ":id/" + id)), 6_000);
        assertNotNull("Missing view " + id, object);
        object.click();
        device.waitForIdle();
    }

    private void clickText(String text) {
        UiObject2 object = device.wait(Until.findObject(By.text(text)), 6_000);
        assertNotNull("Missing text " + text, object);
        object.click();
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
                + "  \"personalProvider\": \"local, unverified screenshot fixture; no real key\",\n"
                + "  \"activityScreenshot\": \"recorded engine-event fixture, not a live turn\",\n"
                + "  \"screenshots\": 12\n"
                + "}";
        try (FileOutputStream out = new FileOutputStream(new File(output, "verification.json"))) {
            out.write(json.getBytes(StandardCharsets.UTF_8));
        }
    }
}
