// @vitest-environment jsdom
import "fake-indexeddb/auto";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsModal } from "@/components/modals";
import { ModelSelector } from "@/components/model-selector";
import { DEFAULT_SETTINGS } from "@/lib/types";
import { ByokStore } from "@/storage/ByokStore";
import { STORES, idbClear } from "@/storage/db";

const modalProps = {
  settings: DEFAULT_SETTINGS,
  online: true,
  busy: false,
  onClose: () => {},
  onUpdate: () => {},
  onExport: () => {},
  onWipe: () => {},
};

beforeEach(async () => {
  await idbClear(STORES.settings);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("unified model Settings", () => {
  it("removes individual fleet controls while retaining Aether Uncensored", () => {
    const { container } = render(React.createElement(SettingsModal, modalProps));
    const text = container.textContent ?? "";
    expect(text).toContain("Aether Uncensored");
    expect(text).toContain("Automatic sequential fallback");
    expect(text).not.toMatch(/Engine [ABCD]|Kaggle|routing mode|Engine power/i);
    expect(container.querySelector('[data-testid="settings-tab-providers"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="settings-tab-agent"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="settings-tab-data"]')).not.toBeNull();
  });

  it("tests a provider through the real UI contract and saves the discovered models", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, models: ["gpt-live-a", "gpt-live-b"] }),
    }) as unknown as typeof fetch;

    render(React.createElement(SettingsModal, modalProps));
    fireEvent.click(screen.getByTestId("settings-tab-providers"));
    fireEvent.click(screen.getByTestId("add-provider"));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-ui-test" } });
    fireEvent.click(screen.getByTestId("test-provider"));

    await screen.findByText("Connection verified");
    await waitFor(() => expect((screen.getByLabelText("Model IDs") as HTMLTextAreaElement).value).toContain("gpt-live-a\ngpt-live-b"));
    fireEvent.click(screen.getByTestId("save-provider"));

    await waitFor(async () => expect(await ByokStore.list()).toHaveLength(1));
    const [saved] = await ByokStore.list();
    expect(saved.apiKey).toBe("sk-ui-test");
    expect(saved.lastTest?.status).toBe("verified");
    expect(saved.models).toEqual(expect.arrayContaining(["gpt-live-a", "gpt-live-b"]));
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/byok/models", expect.objectContaining({ method: "POST" }));
  });
});

describe("collapsible chat model selector", () => {
  it("opens and closes without exposing individual fleet identities", () => {
    render(React.createElement(ModelSelector, { settings: DEFAULT_SETTINGS, onUpdate: () => {}, onOpenSettings: () => {} }));
    expect(screen.queryByTestId("model-selector-popover")).toBeNull();
    fireEvent.click(screen.getByTestId("model-selector-trigger"));
    expect(screen.getByTestId("model-selector-popover").textContent).toContain("Aether Uncensored");
    expect(screen.getByTestId("model-selector-popover").textContent).not.toMatch(/Engine [ABCD]|Kaggle/);
    fireEvent.click(screen.getByTestId("select-aether-uncensored"));
    expect(screen.queryByTestId("model-selector-popover")).toBeNull();
  });

  it("selects a real saved BYOK model", async () => {
    const connection = await ByokStore.create({
      provider: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-selector",
      models: ["gpt-one", "gpt-two"],
      defaultModel: "gpt-one",
      enabled: true,
    });
    const onUpdate = vi.fn();
    render(React.createElement(ModelSelector, { settings: DEFAULT_SETTINGS, onUpdate, onOpenSettings: () => {} }));
    fireEvent.click(screen.getByTestId("model-selector-trigger"));
    const select = await screen.findByLabelText("Model for OpenAI");
    fireEvent.change(select, { target: { value: "gpt-two" } });
    expect(onUpdate).toHaveBeenCalledWith({ model: { kind: "byok", connectionId: connection.id, model: "gpt-two" } });
  });
});
