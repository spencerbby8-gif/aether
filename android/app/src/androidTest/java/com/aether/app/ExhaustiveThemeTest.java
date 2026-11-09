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

/** Every declared Settings destination, document, activity and major dialog in both themes. */
@RunWith(AndroidJUnit4.class)
public class ExhaustiveThemeTest {
    private static final String PKG = "com.aether.app.debug";
    private UiDevice device;
    private File output;
    private String prefix;

    @Before public void setUp() {
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        output = new File(context.getExternalFilesDir(null), "theme-audit");
        assertTrue(output.exists() || output.mkdirs());
        AetherPrefs.warmOnLaunch(context, false);
        AetherPrefs.animations(context, false);
        AetherPrefs.markDisclaimerSeen(context);
    }

    @Test public void auditEveryDeclaredScreenInBothThemes() throws Exception {
        for (String theme : new String[]{"Light", "Midnight"}) {
            prefix = theme.toLowerCase(java.util.Locale.ROOT);
            Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
            AetherPrefs.theme(context, theme);
            settingsHome();
            String[] sections = {"general", "conversation", "appearance", "models", "providers",
                    "activity", "network", "storage", "privacy", "legal", "about"};
            for (String section : sections) settingsSection(section);
            documents();
            chatAndDialogs();
            auth();
            backup();
            workspace();
        }
    }

    private void settingsHome() throws Exception {
        try (ActivityScenario<SettingsActivity> scenario = ActivityScenario.launch(SettingsActivity.class)) {
            shot("settings-home"); bottom("settings-home-bottom");
            clickId("search"); setText("search", "not-a-real-setting");
            shot("settings-search-empty");
            setText("search", "backup");
            shot("settings-search-backup");
        }
    }

    private void settingsSection(String section) throws Exception {
        Intent intent = new Intent(InstrumentationRegistry.getInstrumentation().getTargetContext(), SettingsActivity.class);
        intent.putExtra("section", section);
        try (ActivityScenario<SettingsActivity> scenario = ActivityScenario.launch(intent)) {
            shot("settings-" + section); bottom("settings-" + section + "-bottom");
            if (section.equals("providers")) {
                clickText("Add a provider");
                shot("dialog-provider-add");
                device.pressBack(); device.waitForIdle();
                clickText("Remove all providers and keys");
                shot("dialog-provider-clear");
                device.pressBack(); device.waitForIdle();
            }
            if (section.equals("storage")) {
                clickText("Clear chat history");
                shot("dialog-clear-history");
                device.pressBack(); device.waitForIdle();
            }
            if (section.equals("models")) {
                clickText("Choose a model");
                shot("dialog-model-picker");
                device.pressBack(); device.waitForIdle();
            }
            if (section.equals("conversation")) {
                scrollTo("Connectors & MCP");
                clickText("Connectors & MCP");
                shot("connector-catalog"); bottom("connector-catalog-bottom");
                String[] connectors = {"GitHub", "Supabase", "Vercel", "Google Drive · agent connector",
                        "Slack", "Notion", "Linear", "Custom MCP server"};
                for (String connector : connectors) {
                    scrollTo(connector);
                    clickContains(connector);
                    shot("connector-editor-" + slug(connector));
                    device.pressBack(); device.waitForIdle();
                }
                device.pressBack(); device.waitForIdle();
            }
        }
    }

    private void documents() throws Exception {
        Intent general = new Intent(InstrumentationRegistry.getInstrumentation().getTargetContext(), SettingsActivity.class);
        general.putExtra("section", "general");
        try (ActivityScenario<SettingsActivity> scenario = ActivityScenario.launch(general)) {
            clickText("Review the welcome disclaimer"); shot("document-welcome"); bottom("document-welcome-bottom");
        }
        String[] documents = {"Disclaimer", "Terms of Use", "Privacy Policy", "Content & Responsibility"};
        for (String document : documents) {
            Intent intent = new Intent(InstrumentationRegistry.getInstrumentation().getTargetContext(), SettingsActivity.class);
            intent.putExtra("section", "legal");
            try (ActivityScenario<SettingsActivity> scenario = ActivityScenario.launch(intent)) {
                clickText(document); shot("document-" + slug(document)); bottom("document-" + slug(document) + "-bottom");
            }
        }
    }

    private void chatAndDialogs() throws Exception {
        try (ActivityScenario<ChatActivity> scenario = ActivityScenario.launch(ChatActivity.class)) {
            shot("chat-welcome");
            clickId("attach_btn"); shot("dialog-upload");
            assertNotNull(device.findObject(By.textContains("Upload an image")));
            assertTrue(device.findObject(By.textContains("Connectors & MCP")) == null);
            device.pressBack(); device.waitForIdle();
            clickId("menu_btn"); shot("drawer");
            clickId("account_btn"); shot("dialog-account");
            device.pressBack(); device.waitForIdle();
        }
    }

    private void auth() throws Exception {
        try (ActivityScenario<AuthActivity> scenario = ActivityScenario.launch(AuthActivity.class)) {
            shot("auth-sign-in"); bottom("auth-sign-in-bottom");
            clickText("New to Aether? Create an account"); shot("auth-create-account");
            clickText("Forgot password?"); shot("auth-recovery-validation");
        }
    }

    private void backup() throws Exception {
        try (ActivityScenario<BackupActivity> scenario = ActivityScenario.launch(BackupActivity.class)) {
            shot("backup-signed-out"); bottom("backup-signed-out-bottom");
        }
    }

    private void workspace() throws Exception {
        try (ActivityScenario<WorkspaceActivity> scenario = ActivityScenario.launch(WorkspaceActivity.class)) {
            device.waitForIdle(); shot("workspace"); bottom("workspace-bottom");
        }
    }

    private void bottom(String name) throws Exception {
        UiScrollable scroll = new UiScrollable(new UiSelector().scrollable(true));
        if (scroll.exists()) { scroll.flingToEnd(5); device.waitForIdle(); shot(name); scroll.flingToBeginning(5); }
    }
    private void setText(String id, String value) {
        UiObject2 object = device.wait(Until.findObject(By.res(PKG + ":id/" + id)), 5000);
        assertNotNull(object); object.setText(value); device.waitForIdle();
    }
    private void clickId(String id) {
        UiObject2 object = device.wait(Until.findObject(By.res(PKG + ":id/" + id)), 6000);
        assertNotNull("Missing " + id, object); object.click(); device.waitForIdle();
    }
    private void clickText(String text) {
        UiObject2 object = device.wait(Until.findObject(By.text(text)), 6000);
        assertNotNull("Missing " + text, object); object.click(); device.waitForIdle();
    }
    private void clickContains(String text) {
        UiObject2 object = device.wait(Until.findObject(By.textContains(text)), 6000);
        assertNotNull("Missing " + text, object); object.click(); device.waitForIdle();
    }
    private void scrollTo(String text) throws Exception {
        new UiScrollable(new UiSelector().scrollable(true)).scrollIntoView(new UiSelector().textContains(text));
    }
    private void shot(String name) {
        device.waitForIdle(); File file = new File(output, prefix + "-" + name + ".png");
        assertTrue("Screenshot failed " + name, device.takeScreenshot(file));
        assertTrue("Blank screenshot " + name, file.length() > 5000);
    }
    private static String slug(String text) { return text.toLowerCase(java.util.Locale.ROOT).replaceAll("[^a-z0-9]+", "-"); }
}
