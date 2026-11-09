// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ByokStore } from "@/storage/ByokStore";
import { SettingsStore, normalizeSettings } from "@/storage/SettingsStore";
import { DEFAULT_SETTINGS } from "@/lib/types";
import { STORES, idbClear } from "@/storage/db";
import { exportWorkspace } from "@/storage";
import { downloadText } from "@/lib/utils";

vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>();
  return { ...actual, downloadText: vi.fn() };
});

const input = {
  provider: "openai" as const,
  name: "Personal OpenAI",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-local-only-secret",
  models: ["gpt-test", "gpt-test", "gpt-other"],
  defaultModel: "gpt-test",
  enabled: true,
};

beforeEach(async () => {
  for (const store of Object.values(STORES)) await idbClear(store);
  vi.mocked(downloadText).mockClear();
});

describe("settings migration", () => {
  it("forces legacy individual fleet routing back to unified automatic mode", () => {
    const normalized = normalizeSettings({ provider: "c", model: { kind: "aether" } });
    expect(normalized.provider).toBe("auto");
    expect(normalized.model).toEqual({ kind: "aether" });
  });

  it("rejects malformed model selections and bounds generation controls", () => {
    const normalized = normalizeSettings({
      model: { kind: "byok", connectionId: "", model: "" },
      temperature: 99,
      maxTokens: -5,
      requestTimeoutMs: 1,
    });
    expect(normalized.model).toEqual({ kind: "aether" });
    expect(normalized.temperature).toBe(2);
    expect(normalized.maxTokens).toBe(1);
    expect(normalized.requestTimeoutMs).toBe(10_000);
  });

  it("persists a personal model selection", async () => {
    await SettingsStore.update({ model: { kind: "byok", connectionId: "connection-1", model: "model-1" } });
    expect((await SettingsStore.get()).model).toEqual({ kind: "byok", connectionId: "connection-1", model: "model-1" });
  });
});

describe("BYOK browser persistence", () => {
  it("creates, updates, lists and removes connections", async () => {
    const created = await ByokStore.create(input);
    expect(created.models).toEqual(["gpt-test", "gpt-other"]);
    expect((await ByokStore.get(created.id))?.apiKey).toBe("sk-local-only-secret");

    const updated = await ByokStore.update(created.id, { name: "Renamed", enabled: false, defaultModel: "gpt-other" });
    expect(updated.name).toBe("Renamed");
    expect(updated.enabled).toBe(false);
    expect(updated.createdAt).toBe(created.createdAt);

    await ByokStore.remove(created.id);
    expect(await ByokStore.list()).toEqual([]);
  });

  it("never includes provider records or API keys in workspace exports", async () => {
    await ByokStore.create(input);
    await SettingsStore.update({ systemPrompt: "Export this preference" });
    await exportWorkspace();
    expect(downloadText).toHaveBeenCalledOnce();
    const json = vi.mocked(downloadText).mock.calls[0][1];
    const payload = JSON.parse(json) as Record<string, unknown>;
    expect(json).toContain("Export this preference");
    expect(json).not.toContain("sk-local-only-secret");
    expect(json).not.toContain("Personal OpenAI");
    expect(payload).not.toHaveProperty("byok");
    expect(payload).not.toHaveProperty("connections");
  });

  it("keeps the built-in model as the safe default", () => {
    expect(DEFAULT_SETTINGS.model).toEqual({ kind: "aether" });
  });
});
