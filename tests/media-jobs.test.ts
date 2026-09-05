import "fake-indexeddb/auto";
import { deflateSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { createSurface, encodePNGWith, generateArt } from "@/media/codec";
import { MediaEngine } from "@/media/engine";
import { MediaUnsupportedError, MockAudioProvider, MockImageProvider, MockVideoProvider } from "@/media/providers";
import { TestVideoRecorder } from "@/media/video-recorder";
import { AssetStore } from "@/storage/AssetStore";
import { MediaJobStore } from "@/storage/MediaJobStore";
import { STORES, idbClear } from "@/storage/db";
import type { MediaJob } from "@/lib/types";

function makeEngine(video?: { supported?: boolean; waitMs?: number }): MediaEngine {
  return new MediaEngine({
    image: new MockImageProvider(),
    video: new MockVideoProvider(new TestVideoRecorder(video ?? {})),
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

async function clearAll() {
  await idbClear(STORES.assets);
  await idbClear(STORES.mediaJobs);
}

describe("media job lifecycle", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("runs queued → processing → completed with progress, stages and a persisted asset", async () => {
    const engine = makeEngine();
    const seen: MediaJob[] = [];
    engine.subscribe((job) => seen.push({ ...job }));

    const outcome = await engine.generateImage({ prompt: "ember aurora", conversationId: "conv-x" });
    expect(outcome.job.status).toBe("completed");
    expect(outcome.job.progress).toBe(100);
    expect(outcome.job.stages.every((s) => s.state === "done")).toBe(true);
    expect(outcome.assets).toHaveLength(1);

    /* Progress events were monotonic and included intermediate states. */
    const progress = seen.map((j) => j.progress);
    for (let i = 1; i < progress.length; i += 1) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    expect(seen.some((j) => j.status === "queued")).toBe(true);
    expect(seen.some((j) => j.status === "processing")).toBe(true);

    /* Persisted everywhere: job record + real PNG asset blob. */
    const jobs = await MediaJobStore.list();
    expect(jobs[0].id).toBe(outcome.job.id);
    expect(jobs[0].status).toBe("completed");

    const stored = await AssetStore.get(outcome.assets[0].id);
    expect(stored?.blob.type).toBe("image/png");
    expect(stored?.blob.size).toBeGreaterThan(200);
    expect(stored?.source).toBe("generated");
    expect(stored?.origin?.jobId).toBe(outcome.job.id);
    expect(stored?.note).toContain("mock"); // honest provenance
  });

  it("cancels an in-flight job and persists the cancelled state", async () => {
    const engine = makeEngine({ waitMs: 800 });
    const pending = engine.generateVideo({ prompt: "slow clip" });
    /* Let the job enter processing, then cancel. */
    await new Promise((r) => setTimeout(r, 60));
    const jobs = await MediaJobStore.list();
    const videoJob = jobs.find((j) => j.kind === "video");
    expect(videoJob).toBeDefined();
    expect(engine.cancel(videoJob!.id)).toBe(true);

    const outcome = await pending;
    expect(outcome.job.status).toBe("cancelled");
    const stored = await MediaJobStore.get(videoJob!.id);
    expect(stored?.status).toBe("cancelled");
    expect((await AssetStore.list()).filter((a) => a.kind === "video")).toHaveLength(0);
  });

  it("fails honestly when an edit instruction has no supported operation", async () => {
    const engine = makeEngine();
    const generated = await engine.generateImage({ prompt: "base image" });
    const sourceId = generated.assets[0].id;

    const outcome = await engine.editImage({ sourceAssetId: sourceId, instruction: "make it sparkly and holographic" });
    expect(outcome.job.status).toBe("failed");
    expect(outcome.job.error).toMatch(/no supported operation/i);
    const editStage = outcome.job.stages.find((s) => s.name === "edit");
    expect(editStage?.state).toBe("failed");
  });

  it("refuses unsupported capabilities instead of faking them", async () => {
    const engine = makeEngine({ supported: false });
    await expect(engine.transcribe()).rejects.toThrow(MediaUnsupportedError);
    await expect(engine.speak()).rejects.toThrow(/Phase 5/);
    const videoOutcome = await engine.generateVideo({ prompt: "clip" });
    expect(videoOutcome.job.status).toBe("failed");
    expect(videoOutcome.job.error).toMatch(/not available|refuses/i);
  });
});
