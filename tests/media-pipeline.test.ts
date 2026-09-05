import "fake-indexeddb/auto";
import { deflateSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { createSurface, decodeWav, encodePNGWith, generateArt } from "@/media/codec";
import { MediaEngine } from "@/media/engine";
import { MockAudioProvider, MockImageProvider, MockVideoProvider } from "@/media/providers";
import { TestVideoRecorder } from "@/media/video-recorder";
import { AssetStore } from "@/storage/AssetStore";
import { STORES, idbClear } from "@/storage/db";

function makeEngine(): MediaEngine {
  return new MediaEngine({
    image: new MockImageProvider(),
    video: new MockVideoProvider(new TestVideoRecorder()),
    audio: new MockAudioProvider(),
    pngEncoder: async (surface) => {
      const bytes = encodePNGWith(surface, (input) => new Uint8Array(deflateSync(Buffer.from(input))));
      return new Blob([bytes as unknown as ArrayBuffer], { type: "image/png" });
    },
    imageDecoder: async (blob) => {
      const surface = createSurface(32, 32);
      generateArt(surface, (blob.size % 99_991) + 1);
      return surface;
    },
  });
}

describe("provider-independent pipelines", () => {
  beforeEach(async () => {
    await idbClear(STORES.assets);
    await idbClear(STORES.mediaJobs);
  });

  it("runs generate → enhance → upscale when quality=high and the provider supports it", async () => {
    const engine = makeEngine();
    const outcome = await engine.generateImage({ prompt: "pipeline test", quality: "high", size: 128 });
    expect(outcome.job.status).toBe("completed");
    expect(outcome.job.stages.map((s) => s.name)).toEqual(["generate", "enhance", "upscale"]);
    expect(outcome.job.stages.every((s) => s.state === "done")).toBe(true);
    /* The final asset really is 2× the generation size. */
    expect(outcome.assets[0].width).toBe(256);
    expect(outcome.assets[0].height).toBe(256);
  });

  it("produces multiple outputs for multi-variant requests", async () => {
    const engine = makeEngine();
    const outcome = await engine.generateImage({ prompt: "duet", variants: 2, size: 96 });
    expect(outcome.assets).toHaveLength(2);
    expect(outcome.assets[0].name).toContain("-v1");
    expect(outcome.assets[1].name).toContain("-v2");
  });

  it("edit produces a derived asset linked to its source (before/after)", async () => {
    const engine = makeEngine();
    const generated = await engine.generateImage({ prompt: "edit base", size: 96 });
    const sourceId = generated.assets[0].id;

    const edited = await engine.editImage({ sourceAssetId: sourceId, instruction: "grayscale and darken" });
    expect(edited.job.status).toBe("completed");
    const asset = edited.assets[0];
    expect(asset.derivedFrom).toBe(sourceId);
    expect(asset.source).toBe("edited");
    expect(asset.note).toContain("grayscale");
  });

  it("upscale links the derived asset and doubles dimensions", async () => {
    const engine = makeEngine();
    const generated = await engine.generateImage({ prompt: "small", size: 96 });
    const upscaled = await engine.upscaleImage({ sourceAssetId: generated.assets[0].id });
    /* The test decoder returns 32×32 surfaces; upscaling must really double them. */
    expect(upscaled.assets[0].width).toBe(64);
    expect(upscaled.assets[0].height).toBe(64);
    expect(upscaled.assets[0].derivedFrom).toBe(generated.assets[0].id);
  });

  it("video generation records a real clip asset with duration", async () => {
    const engine = makeEngine();
    const outcome = await engine.generateVideo({ prompt: "flow", durationMs: 1000, size: 128 });
    expect(outcome.job.status).toBe("completed");
    const asset = outcome.assets[0];
    expect(asset.kind).toBe("video");
    expect(asset.mimeType).toBe("video/webm");
    expect(asset.durationMs).toBeGreaterThan(0);
  });

  it("audio generation + trim form a real editing pipeline", async () => {
    const engine = makeEngine();
    const outcome = await engine.generateAudio({ prompt: "gentle", durationMs: 2000 });
    expect(outcome.job.status).toBe("completed");
    const assetId = outcome.assets[0].id;
    const stored = await AssetStore.get(assetId);
    expect(stored).toBeDefined();

    const bytes = new Uint8Array(await stored!.blob.arrayBuffer());
    const trimmed = await engine.audio.trim(bytes, 0, 800, new AbortController().signal);
    expect(trimmed.durationMs).toBeLessThanOrEqual(850);
    const decoded = decodeWav(new Uint8Array(await trimmed.blob.arrayBuffer()));
    expect(decoded.samples.length).toBeGreaterThan(0);
  });

  it("declares capabilities honestly — no fake video upscale or speech", () => {
    const engine = makeEngine();
    expect(engine.video.capabilities().upscale).toBe(false);
    expect(engine.video.capabilities().generate).toBe(true);
    expect(engine.audio.capabilities().tts).toBe(false);
    expect(engine.audio.capabilities().transcribe).toBe(false);
    expect(engine.image.capabilities()).toEqual({ generate: true, edit: true, enhance: true, upscale: true });
  });
});
