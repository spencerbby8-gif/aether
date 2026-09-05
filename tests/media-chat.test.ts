import "fake-indexeddb/auto";
import { deflateSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { brainPlan, brainStep } from "@/agent/brain";
import { createMediaTools } from "@/agent/media-tools";
import type { ToolContext } from "@/agent/tools";
import { encodePNGWith } from "@/media/codec";
import { MediaEngine } from "@/media/engine";
import { MockAudioProvider, MockImageProvider, MockVideoProvider } from "@/media/providers";
import { TestVideoRecorder } from "@/media/video-recorder";
import { AssetStore } from "@/storage/AssetStore";
import { ConversationStore } from "@/storage/ConversationStore";
import { STORES, idbClear } from "@/storage/db";
import { uid } from "@/lib/utils";
import type { TaskStep, ToolSchema } from "@/lib/types";

/* Point the shared engine at node-safe encoders for these tests. */
import { mediaEngine } from "@/media/engine";

mediaEngine.configure({
  pngEncoder: async (surface) => {
    const bytes = encodePNGWith(surface, (input) => new Uint8Array(deflateSync(Buffer.from(input))));
    return new Blob([bytes as unknown as ArrayBuffer], { type: "image/png" });
  },
  imageDecoder: async (blob) => {
    const { createSurface, generateArt } = await import("@/media/codec");
    const surface = createSurface(32, 32);
    generateArt(surface, (blob.size % 99_991) + 1);
    return surface;
  },
});

function stepOf(tool: string): TaskStep {
  return { id: "s1", title: "Media step", state: "pending", attempts: 0, tool };
}

function ctx(conversationId = "conv-media"): ToolContext {
  return { taskId: "task-media", conversationId, projectId: null };
}

async function clearAll() {
  await idbClear(STORES.assets);
  await idbClear(STORES.mediaJobs);
  await idbClear(STORES.conversations);
  await idbClear(STORES.messages);
}

describe("brain routes media intents", () => {
  const tools: ToolSchema[] = [...createMediaTools()].map((t) => t.schema);

  it("routes draw/generate prompts to image.generate with quality flags", () => {
    const plan = brainPlan("Draw a high-quality abstract aurora artwork", tools);
    expect(plan.steps[0].tool).toBe("image.generate");
    const decision = brainStep({
      goal: "Draw a high-quality abstract aurora artwork",
      context: { goal: "x", recent: [], relevantHistory: [], memory: [], files: [] },
      steps: [stepOf("image.generate")],
      currentStep: stepOf("image.generate"),
      observations: [],
      corrections: [],
      tools,
    });
    expect(decision.type).toBe("tool_call");
    if (decision.type === "tool_call") {
      expect(decision.args.quality).toBe("high");
      expect(decision.args.prompt).toContain("aurora");
    }
  });

  it("routes edit instructions to image.edit and upscaling to media.upscale", () => {
    expect(brainPlan("Make this image grayscale and darker", tools).steps[0].tool).toBe("image.edit");
    expect(brainPlan("Upscale the last image to higher resolution", tools).steps[0].tool).toBe("media.upscale");
  });

  it("routes video and audio generation distinctly", () => {
    expect(brainPlan("Generate a short video clip of flowing gradients", tools).steps[0].tool).toBe("video.generate");
    expect(brainPlan("Create a calm ambient audio melody", tools).steps[0].tool).toBe("audio.generate");
  });
});

describe("media tools in the agent registry (chat integration)", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("image.generate executes a real job and returns a chat attachment", async () => {
    const tools = createMediaTools();
    const generate = tools.find((t) => t.schema.name === "image.generate")!;
    const output = await generate.execute({ prompt: "ember test art" }, ctx(), new AbortController().signal);
    const result = typeof output === "string" ? { text: output } : output;
    expect(result.attachments).toHaveLength(1);
    const attachment = result.attachments![0];
    expect(attachment.assetId).toBeTruthy();

    const stored = await AssetStore.get(attachment.assetId!);
    expect(stored?.blob.type).toBe("image/png");
    expect(stored?.origin?.conversationId).toBe("conv-media");

    /* The job is persisted for the workspace media tab. */
    const jobs = await mediaEngine.listJobs();
    expect(jobs[0].status).toBe("completed");
  });

  it("image.edit fails honestly when the conversation has no image", async () => {
    const tools = createMediaTools();
    const edit = tools.find((t) => t.schema.name === "image.edit")!;
    await expect(
      edit.execute({ instruction: "grayscale" }, ctx("conv-empty"), new AbortController().signal),
    ).rejects.toThrow(/No image to edit/);
  });

  it("image.edit consumes an attached image and links before/after", async () => {
    /* Simulate a user pasting an image into the conversation. */
    const conversation = await ConversationStore.create({ title: "Edit chat", projectId: null });
    const surfaceBytes = encodePNGWith(
      await (async () => {
        const { createSurface, generateArt, hashSeed } = await import("@/media/codec");
        const surface = createSurface(48, 48);
        generateArt(surface, hashSeed("attached"));
        return surface;
      })(),
      (input) => new Uint8Array(deflateSync(Buffer.from(input))),
    );
    const blob = new Blob([surfaceBytes as unknown as ArrayBuffer], { type: "image/png" });
    await ConversationStore.saveMessage({
      id: uid(),
      conversationId: conversation.id,
      role: "user",
      content: "make this grayscale",
      status: "complete",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attachments: [{ id: "att-1", kind: "image", name: "pasted.png", mimeType: "image/png", size: blob.size }],
    });
    /* Register the attachment blob like the composer's FileStore would. */
    const { FileStore } = await import("@/storage/FileStore");
    await FileStore.save({ id: "att-1", kind: "image", name: "pasted.png", mimeType: "image/png", size: blob.size, blob });

    const tools = createMediaTools();
    const edit = tools.find((t) => t.schema.name === "image.edit")!;
    const output = await edit.execute({ instruction: "grayscale" }, ctx(conversation.id), new AbortController().signal);
    const result = typeof output === "string" ? { text: output } : output;
    expect(result.text).toContain("Before/after");
    const editedAsset = await AssetStore.get(result.attachments![0].assetId!);
    expect(editedAsset?.derivedFrom).toBeTruthy();
    expect(editedAsset?.source).toBe("edited");
  });

  it("audio.generate returns a playable WAV attachment", async () => {
    const tools = createMediaTools();
    const generate = tools.find((t) => t.schema.name === "audio.generate")!;
    const output = await generate.execute({ prompt: "test melody", durationMs: 1000 }, ctx(), new AbortController().signal);
    const result = typeof output === "string" ? { text: output } : output;
    const attachment = result.attachments![0];
    const stored = await AssetStore.get(attachment.assetId!);
    expect(stored?.blob.type).toBe("audio/wav");
    expect(stored?.durationMs).toBe(1000);
  });
});

/* Sanity: the shared engine can be rebuilt with alternate providers. */
describe("engine extensibility", () => {
  it("accepts injected providers (the Phase 5 seam)", () => {
    const engine = new MediaEngine({
      image: new MockImageProvider(),
      video: new MockVideoProvider(new TestVideoRecorder()),
      audio: new MockAudioProvider(),
    });
    expect(engine.image.id).toBe("mock-image");
    expect(engine.video.id).toBe("mock-video");
    expect(engine.audio.id).toBe("mock-audio");
  });
});
