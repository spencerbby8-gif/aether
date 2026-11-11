package com.aether.app;

import static org.junit.Assert.assertEquals;
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
import androidx.test.uiautomator.Until;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Real taps, typing, Android command execution and banner interaction. Only the
 * external model is a deterministic transport double; no provider claim is made.
 */
@RunWith(AndroidJUnit4.class)
public class LocalAgentInteractionTest {
    private static final String PKG = "com.aether.app.debug";
    private UiDevice device;
    private File output;

    @Before public void setUp() throws Exception {
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        AetherPrefs.warmOnLaunch(context, false);
        AetherPrefs.animations(context, true);
        AetherPrefs.markDisclaimerSeen(context);
        AetherPrefs.theme(context, "Midnight");
        output = new File(context.getExternalFilesDir(null), "local-agent-interaction");
        assertTrue(output.exists() || output.mkdirs());

        ByokClient.Connection fixture = new ByokClient.Connection();
        fixture.id = "byok_local_agent_interaction";
        fixture.provider = "openai";
        fixture.name = "Local Agent Test Provider";
        fixture.defaultModel = "agent-test-model";
        fixture.models.add("agent-test-model");
        fixture.apiKey = "instrumentation-only-not-a-real-key";
        new ByokStore(context).save(fixture);
        ModelPrefs.selectByok(context, fixture.id, fixture.defaultModel);
        device.pressHome(); device.waitForIdle();
    }

    @Test public void typeSendWatchCommandAndToggleRealOutput() throws Exception {
        CountDownLatch releaseFinal = new CountDownLatch(1);
        List<JSONObject> requests = new ArrayList<>();
        ByokClient.Transport transport = new ByokClient.Transport() {
            @Override public ByokClient.Response execute(ByokClient.Request request, EngineCore.TurnHandle handle) throws Exception {
                requests.add(new JSONObject(request.body));
                if (requests.size() == 1) {
                    return response(new JSONObject().put("choices", new JSONArray().put(new JSONObject().put("message", new JSONObject()
                            .put("role", "assistant").put("content", JSONObject.NULL)
                            .put("tool_calls", new JSONArray().put(new JSONObject().put("id", "android-live-command-1")
                                    .put("type", "function").put("function", new JSONObject().put("name", "run_command")
                                            .put("arguments", "{\"command\":\"echo aether-android-live-output\"}"))))))).toString());
                }
                JSONArray messages = requests.get(1).getJSONArray("messages");
                JSONObject result = messages.getJSONObject(messages.length() - 1);
                assertEquals("tool", result.getString("role"));
                assertTrue(result.getString("content").contains("aether-android-live-output"));
                releaseFinal.await(8, TimeUnit.SECONDS);
                return response(new JSONObject().put("choices", new JSONArray().put(new JSONObject().put("message", new JSONObject()
                        .put("role", "assistant").put("content", "The Android command ran successfully and returned the expected live output.")))).toString());
            }
        };

        Intent intent = new Intent(InstrumentationRegistry.getInstrumentation().getTargetContext(), ChatActivity.class);
        try (ActivityScenario<ChatActivity> scenario = ActivityScenario.launch(intent)) {
            scenario.onActivity(activity -> {
                try {
                    Field field = ChatActivity.class.getDeclaredField("byokAgentTransport");
                    field.setAccessible(true); field.set(activity, transport);
                } catch (Exception e) { throw new RuntimeException(e); }
            });
            UiObject2 input = device.wait(Until.findObject(By.res(PKG + ":id/input")), 7000);
            assertNotNull(input);
            input.click(); input.setText("Run a real command and show me everything");
            clickId("send_btn");

            assertVisible("Running commands");
            // echo is intentionally short: by the time UiAutomator observes it,
            // the step is complete and its output well is folded. Open it through
            // the same real control a user taps; long commands stream while open.
            UiObject2 initialExpand = device.wait(Until.findObject(By.desc("Expand Running a command")), 6000);
            assertNotNull(initialExpand); initialExpand.click(); device.waitForIdle();
            assertVisible("OUTPUT");
            assertVisible("aether-android-live-output");
            assertTrue("Agent activity is not running while the model continues", activityRunning(scenario));
            shot("01-command-output-while-agent-continues");

            UiObject2 collapse = device.wait(Until.findObject(By.desc("Collapse Running a command")), 6000);
            assertNotNull(collapse); collapse.click(); device.waitForIdle();
            assertTrue("Command output did not collapse", device.wait(Until.gone(By.textContains("aether-android-live-output")), 5000));
            shot("02-command-output-collapsed");

            UiObject2 expand = device.wait(Until.findObject(By.desc("Expand Running a command")), 6000);
            assertNotNull(expand); expand.click(); device.waitForIdle();
            assertVisible("aether-android-live-output");
            shot("03-command-output-expanded-again");

            releaseFinal.countDown();
            assertVisible("The Android command ran successfully");
            assertVisible("Ran a command");
            assertTrue("Finished activity still animates", !activityRunning(scenario));
            shot("04-command-complete-and-auto-folded");
            assertEquals(2, requests.size());
            writeVerification(requests.size());
        } finally {
            releaseFinal.countDown();
        }
    }

    private boolean activityRunning(ActivityScenario<ChatActivity> scenario) {
        final boolean[] running = {true};
        scenario.onActivity(activity -> {
            try {
                java.lang.reflect.Field live = ChatActivity.class.getDeclaredField("liveBubble");
                live.setAccessible(true);
                running[0] = live.get(activity) != null;
            } catch (Exception e) { throw new RuntimeException(e); }
        });
        return running[0];
    }

    private static ByokClient.Response response(String body) {
        return new ByokClient.Response() {
            @Override public int status() { return 200; }
            @Override public InputStream body() { return new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)); }
            @Override public void close() { }
        };
    }

    private void clickId(String id) {
        UiObject2 object = device.wait(Until.findObject(By.res(PKG + ":id/" + id)), 7000);
        assertNotNull(object); object.click(); device.waitForIdle();
    }
    private void assertVisible(String text) {
        assertNotNull("Missing visible text: " + text, device.wait(Until.findObject(By.textContains(text)), 8000));
    }
    private void shot(String name) {
        device.waitForIdle();
        assertTrue(device.takeScreenshot(new File(output, name + ".png")));
    }
    private void writeVerification(int providerRounds) throws Exception {
        JSONObject proof = new JSONObject()
                .put("navigation", "typed prompt and clicked Send; clicked collapse and expand controls")
                .put("provider", "deterministic instrumentation transport, not a live external provider")
                .put("commandExecution", "real /system/bin/echo child process on Android")
                .put("providerRounds", providerRounds)
                .put("liveOutputVerified", true)
                .put("collapseExpandVerified", true);
        java.nio.file.Files.write(new File(output, "verification.json").toPath(),
                proof.toString(2).getBytes(StandardCharsets.UTF_8));
    }
}
