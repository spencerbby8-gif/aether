package com.aether.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
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

import com.aether.app.core.ChatMessage;
import com.aether.app.core.ChatSession;
import com.aether.app.core.ChatStore;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** Live loopback HTTP engine, not recorded events: exercises the actual ChatActivity stream path. */
@RunWith(AndroidJUnit4.class)
public class LiveExecutionHandshakeTest {
    private static final String PKG = "com.aether.app.debug";
    private static final String COMMAND = "printf live-approval-proof";
    private UiDevice device;
    private File output;

    @Before public void setUp() {
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        AetherPrefs.warmOnLaunch(context, false);
        AetherPrefs.animations(context, false);
        AetherPrefs.markDisclaimerSeen(context);
        output = new File(context.getExternalFilesDir(null), "live-execution");
        assertTrue(output.exists() || output.mkdirs());
    }

    @Test public void manualApprovalStartsOnceAndCompletionFolds() throws Exception {
        AetherPrefs.theme(InstrumentationRegistry.getInstrumentation().getTargetContext(), "Light");
        try (TestEngine engine = new TestEngine(true); ActivityScenario<ChatActivity> scenario = launch()) {
            execute(scenario, engine, false);
            assertNotNull("Exact command approval card missing", device.wait(Until.findObject(By.text("Approve once")), 7000));
            assertVisible(COMMAND);
            assertFalse("Engine started before user approval", engine.started.get());
            shot("light-manual-command-before-execution");
            click("Approve once");
            assertTrue("Approval did not reach engine", engine.decision.await(7, TimeUnit.SECONDS));
            assertTrue(engine.approved.get());
            assertTrue("Command did not start after approval", engine.startedLatch.await(7, TimeUnit.SECONDS));
            assertEquals(1, engine.startCount.get());
            assertVisible(COMMAND);
            shot("light-command-expanded-live");
            engine.complete.countDown();
            assertTrue(engine.finished.await(7, TimeUnit.SECONDS));
            assertTrue("Command did not fold after completion", device.wait(Until.gone(By.textContains(COMMAND)), 7000));
            shot("light-command-folded-after-completion");
        }
    }

    @Test public void denialReturnsWithoutStartingCommand() throws Exception {
        AetherPrefs.theme(InstrumentationRegistry.getInstrumentation().getTargetContext(), "Midnight");
        try (TestEngine engine = new TestEngine(true); ActivityScenario<ChatActivity> scenario = launch()) {
            execute(scenario, engine, false);
            assertVisible("Deny"); assertFalse(engine.started.get());
            shot("dark-manual-command-before-execution");
            click("Deny");
            assertTrue(engine.decision.await(7, TimeUnit.SECONDS));
            assertFalse(engine.approved.get());
            assertFalse(engine.started.get());
            assertEquals(0, engine.startCount.get());
            assertTrue(engine.finished.await(7, TimeUnit.SECONDS));
            shot("dark-command-denied");
        }
    }

    @Test public void autoRunStartsWithoutApprovalControls() throws Exception {
        try (TestEngine engine = new TestEngine(false); ActivityScenario<ChatActivity> scenario = launch()) {
            execute(scenario, engine, true);
            assertTrue(engine.startedLatch.await(7, TimeUnit.SECONDS));
            assertTrue(engine.autoRunPayload.get());
            assertEquals(0, engine.approvalEvents.get());
            assertTrue(device.findObject(By.text("Approve once")) == null);
            assertVisible(COMMAND);
            engine.complete.countDown();
            assertTrue(engine.finished.await(7, TimeUnit.SECONDS));
            assertTrue(device.wait(Until.gone(By.textContains(COMMAND)), 7000));
        }
    }

    @Test public void stopDeniesThePendingCommand() throws Exception {
        try (TestEngine engine = new TestEngine(true); ActivityScenario<ChatActivity> scenario = launch()) {
            execute(scenario, engine, false);
            assertVisible("Approve once");
            clickId("stop_btn");
            assertTrue("Stop did not deliver denial", engine.decision.await(7, TimeUnit.SECONDS));
            assertFalse(engine.approved.get());
            assertFalse(engine.started.get());
            assertEquals(0, engine.startCount.get());
        }
    }

    private ActivityScenario<ChatActivity> launch() {
        Intent intent = new Intent(InstrumentationRegistry.getInstrumentation().getTargetContext(), ChatActivity.class);
        return ActivityScenario.launch(intent);
    }

    private void execute(ActivityScenario<ChatActivity> scenario, TestEngine engine, boolean auto) throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        AetherPrefs.autoRunCommands(context, auto);
        final Object[] bubble = new Object[1];
        scenario.onActivity(activity -> {
            try {
                ChatStore store = new ChatStore(new File(context.getFilesDir(), "chats"));
                ChatSession session = store.create(null);
                Field current = ChatActivity.class.getDeclaredField("current"); current.setAccessible(true); current.set(activity, session);
                Method add = ChatActivity.class.getDeclaredMethod("addAssistantBubble"); add.setAccessible(true);
                bubble[0] = add.invoke(activity);
                ChatMessage model = new ChatMessage(ChatMessage.ROLE_ASSISTANT);
                session.messages.add(model);
                set(bubble[0], "model", model); set(bubble[0], "session", session.id);
                Credentials.Config config = new Credentials.Config(new JSONObject()
                        .put("kernelSlug", "loopback-proof").put("offKey", "loopback-key")
                        .put("beaconTopic", "unused").put("beaconSecret", "unused"));
                set(activity, "cfg", config);
                Method streaming = ChatActivity.class.getDeclaredMethod("setStreaming", boolean.class);
                streaming.setAccessible(true); streaming.invoke(activity, true);
            } catch (Exception e) { throw new RuntimeException(e); }
        });
        Class<?> type = Class.forName("com.aether.app.ChatActivity$AssistantBubble");
        final Method stream = ChatActivity.class.getDeclaredMethod("streamWithFailover", String.class, String.class,
                String.class, type, List.class, List.class, boolean.class);
        stream.setAccessible(true);
        // The activity is captured on the main thread, but the turn itself runs
        // on its own thread -- exactly as a send does. Invoking it inside
        // onActivity would block the main looper that renders the approval card.
        final ChatActivity[] activityRef = new ChatActivity[1];
        scenario.onActivity(activity -> activityRef[0] = activity);
        final AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread thread = new Thread(() -> {
            try {
                stream.invoke(activityRef[0], engine.url(), "execute the proof command", "execute the proof command",
                        bubble[0], new ArrayList<String>(), new ArrayList<EngineCore.Msg>(), false);
            } catch (Throwable e) { failure.set(e); }
        }, "aether-live-proof-turn");
        thread.setDaemon(true);
        thread.start();
        if (!engine.chat.await(10, TimeUnit.SECONDS)) {
            Throwable cause = failure.get();
            throw new AssertionError("Live HTTP chat was not requested; app-side error=" + turnNote(bubble[0])
                    + "; requests=" + engine.requests
                    + (cause == null ? "" : "; thrown=" + cause), cause);
        }
        if (failure.get() != null) throw new AssertionError("The live turn failed to start", failure.get());
    }

    /** The bubble's own record of what went wrong, so a failure names the cause. */
    private static String turnNote(Object bubble) {
        try {
            Field model = bubble.getClass().getDeclaredField("model"); model.setAccessible(true);
            Object message = model.get(bubble);
            if (message == null) return "no message";
            Field status = message.getClass().getField("status"); status.setAccessible(true);
            Field note = message.getClass().getField("note"); note.setAccessible(true);
            return String.valueOf(status.get(message)) + "/" + String.valueOf(note.get(message));
        } catch (Throwable e) { return "unreadable (" + e + ")"; }
    }

    private static void set(Object target, String name, Object value) throws Exception {
        Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); field.set(target, value);
    }
    private void click(String text) {
        UiObject2 object = device.wait(Until.findObject(By.text(text)), 7000); assertNotNull(object); object.click(); device.waitForIdle();
    }
    private void clickId(String id) {
        UiObject2 object = device.wait(Until.findObject(By.res(PKG + ":id/" + id)), 7000); assertNotNull(object); object.click(); device.waitForIdle();
    }
    private void assertVisible(String text) { assertNotNull("Missing " + text, device.wait(Until.findObject(By.textContains(text)), 7000)); }
    private void shot(String name) { device.waitForIdle(); assertTrue(device.takeScreenshot(new File(output, name + ".png"))); }

    private static final class TestEngine implements AutoCloseable {
        final ServerSocket server;
        final ExecutorService pool = Executors.newCachedThreadPool();
        final CountDownLatch chat = new CountDownLatch(1), decision = new CountDownLatch(1),
                startedLatch = new CountDownLatch(1), finished = new CountDownLatch(1), complete = new CountDownLatch(1);
        final AtomicBoolean started = new AtomicBoolean(), approved = new AtomicBoolean(), autoRunPayload = new AtomicBoolean();
        final java.util.concurrent.atomic.AtomicInteger startCount = new java.util.concurrent.atomic.AtomicInteger(), approvalEvents = new java.util.concurrent.atomic.AtomicInteger();
        final List<String> requests = Collections.synchronizedList(new ArrayList<>());
        final boolean manual;
        volatile boolean running = true;

        TestEngine(boolean manual) throws Exception {
            this.manual = manual; server = new ServerSocket(0, 20, java.net.InetAddress.getByName("127.0.0.1"));
            pool.execute(this::accept);
        }
        String url() { return "http://127.0.0.1:" + server.getLocalPort(); }
        void accept() {
            while (running) {
                try { Socket socket = server.accept(); pool.execute(() -> handle(socket)); }
                catch (Exception e) { if (running) e.printStackTrace(); return; }
            }
        }
        void handle(Socket socket) {
            try (Socket s = socket) {
                s.setSoTimeout(12_000);
                InputStream in = s.getInputStream();
                BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
                String line = reader.readLine(); if (line == null) return;
                String path = line.split(" ")[1]; int length = 0; String header;
                while ((header = reader.readLine()) != null && !header.isEmpty()) {
                    if (header.toLowerCase(java.util.Locale.ROOT).startsWith("content-length:")) length = Integer.parseInt(header.substring(15).trim());
                }
                char[] chars = new char[length]; int offset = 0;
                while (offset < length) { int n = reader.read(chars, offset, length - offset); if (n < 0) break; offset += n; }
                String body = new String(chars, 0, offset); requests.add(path + " " + body);
                OutputStream out = s.getOutputStream();
                if (path.equals("/api/approval")) {
                    approved.set(new JSONObject(body).optBoolean("approved")); decision.countDown();
                    respond(out, 200, "application/json", "{\"status\":\"recorded\"}"); return;
                }
                if (!path.equals("/api/chat")) { respond(out, 404, "text/plain", "not found"); return; }
                JSONObject request = new JSONObject(body); autoRunPayload.set(request.optBoolean("auto_run_commands", true)); chat.countDown();
                out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8)); out.flush();
                if (manual) {
                    approvalEvents.incrementAndGet();
                    event(out, new JSONObject().put("approval", new JSONObject().put("id", "live-command-1")
                            .put("session", request.optString("session", "default")).put("tool", "run_command").put("command", COMMAND)));
                    if (!decision.await(10, TimeUnit.SECONDS)) return;
                }
                if (approved.get() || !manual) {
                    started.set(true); startCount.incrementAndGet(); startedLatch.countDown();
                    event(out, thinking("🛠️ run_command({\"command\":\"" + COMMAND + "\"})"));
                    complete.await(10, TimeUnit.SECONDS);
                    event(out, thinking("↳ run_command returned 19 chars"));
                } else {
                    event(out, thinking("↳ run_command denied by user; no subprocess was created"));
                }
                event(out, new JSONObject().put("done", true)); finished.countDown();
            } catch (Exception ignored) { }
        }
        static JSONObject thinking(String text) throws Exception { return new JSONObject().put("message", new JSONObject().put("thinking", text)); }
        static void event(OutputStream out, JSONObject value) throws Exception { out.write((value.toString() + "\n").getBytes(StandardCharsets.UTF_8)); out.flush(); }
        static void respond(OutputStream out, int code, String type, String body) throws Exception {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            out.write(("HTTP/1.1 " + code + " OK\r\nContent-Type: " + type + "\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            out.write(bytes); out.flush();
        }
        @Override public void close() { running = false; complete.countDown(); try { server.close(); } catch (Exception ignored) { } pool.shutdownNow(); }
    }
}
