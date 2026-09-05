import type { AttachmentMeta, ToolSchema } from "@/lib/types";
import { truncate } from "@/lib/utils";
import { AssetStore } from "@/storage/AssetStore";
import { ConversationStore } from "@/storage/ConversationStore";
import { FileStore } from "@/storage/FileStore";
import { mediaEngine } from "@/media/engine";
import { MediaUnsupportedError } from "@/media/providers";
import type { ToolContext, ToolExecutor, ToolOutput } from "./tools";

/**
 * Phase 4 media tools — generation and editing run directly in chat.
 * They execute real jobs through the MediaEngine, stream progress via the
 * runtime's onProgress channel, and return assets as message attachments.
 */

function assetAttachment(asset: { id: string; kind: "image" | "video" | "audio"; name: string; mimeType: string; size: number }): AttachmentMeta {
  return {
    id: asset.id,
    kind: asset.kind === "image" ? "image" : "file",
    name: asset.name,
    mimeType: asset.mimeType,
    size: asset.size,
    assetId: asset.id,
  };
}

function describeProgress(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** Find the most recent image the user attached to this conversation. */
async function latestImageSource(conversationId: string): Promise<{ assetId: string } | null> {
  const messages = await ConversationStore.messagesOf(conversationId);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user" || !message.attachments) continue;
    for (let j = message.attachments.length - 1; j >= 0; j -= 1) {
      const attachment = message.attachments[j];
      if (!attachment.mimeType.startsWith("image/")) continue;
      if (attachment.assetId) return { assetId: attachment.assetId };
      /* Imported pasted/uploaded files become workspace assets on first edit. */
      const stored = await FileStore.get(attachment.id);
      if (stored) {
        const asset = await AssetStore.save(
          {
            name: stored.name,
            kind: "image",
            mimeType: stored.mimeType,
            size: stored.size,
            source: "uploaded",
            origin: { conversationId },
            derivedFrom: null,
          },
          stored.blob,
        );
        return { assetId: asset.id };
      }
    }
  }
  return null;
}

export function createMediaTools(): ToolExecutor[] {
  return [
    {
      schema: {
        name: "image.generate",
        description: "Generate image artwork from a prompt. High quality runs enhance + upscale stages.",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "What to generate" },
            quality: { type: "string", enum: ["standard", "high"], description: "high = generate → enhance → upscale" },
            variants: { type: "number", description: "1–3 outputs" },
          },
          required: ["prompt"],
        },
      },
      async execute(args, ctx: ToolContext, signal): Promise<ToolOutput> {
        const prompt = String(args.prompt ?? ctx.goalHint ?? "abstract artwork");
        const quality = args.quality === "high" ? "high" : "standard";
        const variants = typeof args.variants === "number" ? Math.max(1, Math.min(3, Math.floor(args.variants))) : 1;
        const outcome = await mediaEngine.generateImage({
          prompt,
          quality,
          variants,
          conversationId: ctx.conversationId,
        });
        if (outcome.job.status !== "completed") throw new Error(outcome.job.error ?? "Image generation failed.");
        const attachments = outcome.assets.map(assetAttachment);
        return {
          text: `Generated ${outcome.assets.length} image(s) at ${outcome.assets[0]?.width}×${outcome.assets[0]?.height}: ${outcome.assets.map((a) => a.name).join(", ")}.`,
          attachments,
        };
      },
    },
    {
      schema: {
        name: "image.edit",
        description: "Edit the latest image in this conversation with a natural-language instruction.",
        parameters: {
          type: "object",
          properties: { instruction: { type: "string", description: "e.g. make it grayscale and darker" } },
          required: ["instruction"],
        },
      },
      async execute(args, ctx, signal): Promise<ToolOutput> {
        const instruction = String(args.instruction ?? "");
        const source = await latestImageSource(ctx.conversationId);
        if (!source) {
          throw new Error("No image to edit — attach or generate one in this conversation first.");
        }
        ctx.onProgress?.("Editing image…");
        const outcome = await mediaEngine.editImage({
          sourceAssetId: source.assetId,
          instruction,
          conversationId: ctx.conversationId,
        });
        if (outcome.job.status !== "completed") throw new Error(outcome.job.error ?? "Image editing failed.");
        const asset = outcome.assets[0];
        return {
          text: `Edited image saved as ${asset?.name} (${asset?.width}×${asset?.height}). Before/after available in the viewer.`,
          attachments: outcome.assets.map(assetAttachment),
        };
      },
    },
    {
      schema: {
        name: "media.upscale",
        description: "Upscale the latest image in this conversation (real 2× resample when supported).",
        parameters: { type: "object", properties: {} },
      },
      async execute(_args, ctx): Promise<ToolOutput> {
        const source = await latestImageSource(ctx.conversationId);
        if (!source) throw new Error("No image to upscale — attach or generate one first.");
        const outcome = await mediaEngine.upscaleImage({ sourceAssetId: source.assetId, conversationId: ctx.conversationId });
        if (outcome.job.status !== "completed") throw new Error(outcome.job.error ?? "Upscaling failed.");
        const asset = outcome.assets[0];
        return {
          text: `Upscaled to ${asset?.width}×${asset?.height}.`,
          attachments: outcome.assets.map(assetAttachment),
        };
      },
    },
    {
      schema: {
        name: "video.generate",
        description: "Generate a short video clip from a prompt (mock renderer; honest limitations).",
        parameters: {
          type: "object",
          properties: { prompt: { type: "string" }, durationMs: { type: "number", description: "500–3000" } },
          required: ["prompt"],
        },
      },
      async execute(args, ctx): Promise<ToolOutput> {
        const prompt = String(args.prompt ?? "flowing gradient");
        const durationMs = typeof args.durationMs === "number" ? Math.max(500, Math.min(3000, args.durationMs)) : 2000;
        const outcome = await mediaEngine.generateVideo({ prompt, durationMs, conversationId: ctx.conversationId });
        if (outcome.job.status !== "completed") throw new Error(outcome.job.error ?? "Video generation failed.");
        const asset = outcome.assets[0];
        return {
          text: `Generated ${(asset?.durationMs ?? 0) / 1000}s clip: ${asset?.name}.`,
          attachments: outcome.assets.map(assetAttachment),
        };
      },
    },
    {
      schema: {
        name: "audio.generate",
        description: "Synthesize a short audio clip from a prompt (real WAV output).",
        parameters: {
          type: "object",
          properties: { prompt: { type: "string" }, durationMs: { type: "number", description: "500–8000" } },
          required: ["prompt"],
        },
      },
      async execute(args, ctx): Promise<ToolOutput> {
        const prompt = String(args.prompt ?? "ambient melody");
        const durationMs = typeof args.durationMs === "number" ? Math.max(500, Math.min(8000, args.durationMs)) : 3000;
        const outcome = await mediaEngine.generateAudio({ prompt, durationMs, conversationId: ctx.conversationId });
        if (outcome.job.status !== "completed") throw new Error(outcome.job.error ?? "Audio generation failed.");
        const asset = outcome.assets[0];
        return {
          text: `Synthesized ${(asset?.durationMs ?? 0) / 1000}s WAV: ${asset?.name}.`,
          attachments: outcome.assets.map(assetAttachment),
        };
      },
    },
  ];
}

export const MEDIA_TOOL_SCHEMAS: ToolSchema[] = createMediaTools().map((tool) => tool.schema);

/** Honest refusal surfacing for unsupported mock capabilities. */
export function describeUnsupported(error: unknown): string {
  if (error instanceof MediaUnsupportedError) return error.message;
  return error instanceof Error ? truncate(error.message, 200) : "The media operation failed.";
}
