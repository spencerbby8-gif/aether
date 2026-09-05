import type { MediaAssetMeta, MediaJob, MediaJobStage } from "@/lib/types";
import { uid } from "@/lib/utils";
import { AssetStore, type StoredAsset } from "@/storage/AssetStore";
import { MediaJobStore } from "@/storage/MediaJobStore";
import type { PixelSurface } from "./codec";
import {
  MediaUnsupportedError,
  MockAudioProvider,
  MockImageProvider,
  MockVideoProvider,
  type AudioProvider,
  type ImageProvider,
  type VideoProvider,
} from "./providers";
import { createDefaultVideoRecorder } from "./video-recorder";

/**
 * MediaEngine — the unified Phase 4 MediaProvider.
 * Owns async media jobs (queued → processing → completed/failed/cancelled),
 * progress events, cancellation and workspace asset tracking. Orchestrates
 * provider-independent pipelines: generation → enhancement → upscaling.
 */

export { MediaUnsupportedError };

export interface ImageJobSpec {
  prompt: string;
  /** "standard" | "high" — high runs generate → enhance → upscale. */
  quality?: "standard" | "high";
  variants?: number;
  size?: number;
  conversationId?: string | null;
}

export interface EditJobSpec {
  sourceAssetId: string;
  instruction: string;
  conversationId?: string | null;
}

export interface VideoJobSpec {
  prompt: string;
  durationMs?: number;
  size?: number;
  conversationId?: string | null;
}

export interface AudioJobSpec {
  prompt: string;
  durationMs?: number;
  conversationId?: string | null;
}

export interface JobOutcome {
  job: MediaJob;
  assets: Array<Omit<StoredAsset, "blob">>;
}

type JobListener = (job: MediaJob) => void;

interface ActiveRun {
  abort: AbortController;
}

export class MediaEngine {
  readonly image: ImageProvider;
  readonly video: VideoProvider;
  readonly audio: AudioProvider;
  /** Injected for non-browser environments (tests); browser uses canvas. */
  private pngEncoder?: (surface: PixelSurface) => Promise<Blob>;
  private imageDecoder?: (blob: Blob) => Promise<PixelSurface>;

  private active = new Map<string, ActiveRun>();
  private listeners = new Set<JobListener>();
  private lastPersist = new Map<string, number>();

  constructor(options?: {
    image?: ImageProvider;
    video?: VideoProvider;
    audio?: AudioProvider;
    pngEncoder?: (surface: PixelSurface) => Promise<Blob>;
    imageDecoder?: (blob: Blob) => Promise<PixelSurface>;
  }) {
    this.image = options?.image ?? new MockImageProvider();
    this.video = options?.video ?? new MockVideoProvider(createDefaultVideoRecorder());
    this.audio = options?.audio ?? new MockAudioProvider();
    this.pngEncoder = options?.pngEncoder;
    this.imageDecoder = options?.imageDecoder;
  }

  /** Inject software codec seams (tests / non-browser environments). */
  configure(options: {
    pngEncoder?: (surface: PixelSurface) => Promise<Blob>;
    imageDecoder?: (blob: Blob) => Promise<PixelSurface>;
  }): void {
    if (options.pngEncoder) this.pngEncoder = options.pngEncoder;
    if (options.imageDecoder) this.imageDecoder = options.imageDecoder;
  }

  subscribe(listener: JobListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listJobs(): Promise<MediaJob[]> {
    return MediaJobStore.list();
  }

  cancel(jobId: string): boolean {
    const run = this.active.get(jobId);
    if (!run) return false;
    run.abort.abort();
    return true;
  }

  /** Abort every in-flight job (used by workspace wipe). */
  cancelAll(): void {
    for (const run of this.active.values()) run.abort.abort();
  }

  /* ---------------- internals ---------------- */

  private notify(job: MediaJob, force = false): void {
    for (const listener of this.listeners) listener({ ...job });
    const now = Date.now();
    const last = this.lastPersist.get(job.id) ?? 0;
    if (force || job.status !== "processing" || now - last > 400) {
      this.lastPersist.set(job.id, now);
      void MediaJobStore.save({ ...job });
    }
  }

  private createJob(kind: MediaJob["kind"], operation: string, inputSummary: string, stages: string[], conversationId?: string | null): MediaJob {
    const now = Date.now();
    const job: MediaJob = {
      id: uid(),
      kind,
      operation,
      status: "queued",
      progress: 0,
      stages: stages.map((name) => ({ name, state: "pending" as const })),
      inputSummary,
      outputAssetIds: [],
      conversationId: conversationId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    return job;
  }

  private setStage(job: MediaJob, name: string, state: MediaJobStage["state"]): void {
    const stage = job.stages.find((s) => s.name === name);
    if (stage) stage.state = state;
  }

  private checkAbort(signal: AbortSignal): void {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  }

  /** Save a surface as a PNG asset (canvas in browser, injected encoder in tests). */
  private async saveSurfaceAsset(
    surface: PixelSurface,
    meta: Omit<MediaAssetMeta, "size" | "width" | "height" | "mimeType" | "createdAt" | "id"> & { id?: string },
  ): Promise<StoredAsset> {
    let blob: Blob;
    if (this.pngEncoder) {
      blob = await this.pngEncoder(surface);
    } else if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = surface.width;
      canvas.height = surface.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable.");
      const imageData = new ImageData(new Uint8ClampedArray(surface.data), surface.width, surface.height);
      ctx.putImageData(imageData, 0, 0);
      blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("PNG encoding failed."))), "image/png");
      });
    } else {
      throw new Error("No PNG encoder available in this environment.");
    }
    return AssetStore.save(
      { ...meta, size: blob.size, width: surface.width, height: surface.height, mimeType: "image/png" },
      blob,
    );
  }

  private slug(prompt: string): string {
    return prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "media";
  }

  private decodeBlob(blob: Blob): Promise<PixelSurface> {
    return decodeAssetToSurface(blob, this.imageDecoder);
  }

  private async runJob(
    job: MediaJob,
    work: (signal: AbortSignal, report: (progress: number, stage?: string, stageState?: MediaJobStage["state"]) => void) => Promise<string[]>,
  ): Promise<JobOutcome> {
    const abort = new AbortController();
    this.active.set(job.id, { abort });
    this.notify(job, true);

    try {
      job.status = "processing";
      this.notify(job, true);
      const assetIds = await work(abort.signal, (progress, stage, stageState) => {
        job.progress = Math.round(Math.max(job.progress, Math.min(100, progress * 100)));
        if (stage && stageState) this.setStage(job, stage, stageState);
        this.notify(job);
      });
      job.outputAssetIds = assetIds;
      job.progress = 100;
      for (const stage of job.stages) {
        if (stage.state === "pending" || stage.state === "running") stage.state = "done";
      }
      job.status = "completed";
      this.notify(job, true);
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        job.status = "cancelled";
        job.error = "Cancelled.";
      } else {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : "The media job failed.";
      }
      for (const stage of job.stages) {
        if (stage.state === "running" || stage.state === "pending") stage.state = stage.state === "running" ? "failed" : "skipped";
      }
      this.notify(job, true);
    } finally {
      this.active.delete(job.id);
      this.lastPersist.delete(job.id);
    }

    const assets = [];
    for (const assetId of job.outputAssetIds) {
      const meta = await AssetStore.get(assetId);
      if (meta) {
        const { blob: _blob, ...rest } = meta;
        assets.push(rest);
      }
    }
    return { job, assets };
  }

  /* ---------------- pipelines ---------------- */

  async generateImage(spec: ImageJobSpec): Promise<JobOutcome> {
    const high = spec.quality === "high";
    const variants = Math.max(1, Math.min(3, spec.variants ?? 1));
    const size = Math.max(128, Math.min(512, spec.size ?? 384));
    const stages = variants > 1 ? [`generate ×${variants}`] : ["generate"];
    if (high) stages.push("enhance", "upscale");
    const job = this.createJob("image", high ? "generate (high-quality pipeline)" : "generate", spec.prompt, stages, spec.conversationId);

    return this.runJob(job, async (signal, report) => {
      const outputIds: string[] = [];
      const total = variants * (high ? 3 : 1);
      let done = 0;
      for (let v = 0; v < variants; v += 1) {
        this.checkAbort(signal);
        const variantPrompt = variants > 1 ? `${spec.prompt} (variant ${v + 1})` : spec.prompt;
        this.setStage(job, stages[0], "running");
        let surface = await this.image.generate(variantPrompt, size, signal);
        done += 1;
        report(done / total, stages[0], v === variants - 1 ? "done" : "running");

        if (high) {
          this.setStage(job, "enhance", "running");
          surface = await this.image.enhance(surface, signal);
          done += 1;
          report(done / total, "enhance", "done");

          this.setStage(job, "upscale", "running");
          surface = await this.image.upscale(surface, 2, signal);
          done += 1;
          report(done / total, "upscale", "done");
        }

        const asset = await this.saveSurfaceAsset(surface, {
          name: `generated-${this.slug(spec.prompt)}${variants > 1 ? `-v${v + 1}` : ""}.png`,
          kind: "image",
          source: "generated",
          origin: { conversationId: spec.conversationId ?? undefined, jobId: job.id, tool: "image.generate" },
          derivedFrom: null,
          prompt: spec.prompt,
          note: "Procedural mock artwork — deterministic, not a diffusion model. Real generation arrives in Phase 5.",
        });
        outputIds.push(asset.id);
      }
      return outputIds;
    });
  }

  async editImage(spec: EditJobSpec): Promise<JobOutcome> {
    const job = this.createJob("image", "edit", spec.instruction, ["load", "edit"], spec.conversationId);
    return this.runJob(job, async (signal, report) => {
      this.setStage(job, "load", "running");
      const source = await AssetStore.get(spec.sourceAssetId);
      if (!source) throw new Error("The source asset no longer exists.");
      const surface = await this.decodeBlob(source.blob);
      this.setStage(job, "load", "done");
      report(0.3, "load", "done");

      this.setStage(job, "edit", "running");
      const edited = await this.image.edit(surface, spec.instruction, signal);
      report(0.9, "edit", "done");

      const asset = await this.saveSurfaceAsset(edited.surface, {
        name: source.name.replace(/\.png$/, "") + `-edited.png`,
        kind: "image",
        source: "edited",
        origin: { conversationId: spec.conversationId ?? undefined, jobId: job.id, tool: "image.edit" },
        derivedFrom: source.id,
        prompt: spec.instruction,
        note: `Mock edit: ${edited.applied.join(" + ")}. Real model-driven editing arrives in Phase 5.`,
      });
      return [asset.id];
    });
  }

  async upscaleImage(spec: { sourceAssetId: string; conversationId?: string | null }): Promise<JobOutcome> {
    if (!this.image.capabilities().upscale) {
      throw new MediaUnsupportedError("The active image provider does not support upscaling.");
    }
    const job = this.createJob("image", "upscale", "2× resample", ["load", "upscale"], spec.conversationId);
    return this.runJob(job, async (signal, report) => {
      const source = await AssetStore.get(spec.sourceAssetId);
      if (!source) throw new Error("The source asset no longer exists.");
      const surface = await this.decodeBlob(source.blob);
      this.setStage(job, "load", "done");
      report(0.3, "load", "done");

      this.setStage(job, "upscale", "running");
      const upscaled = await this.image.upscale(surface, 2, signal);
      report(0.9, "upscale", "done");

      const asset = await this.saveSurfaceAsset(upscaled, {
        name: source.name.replace(/\.png$/, "") + "-2x.png",
        kind: "image",
        source: "derived",
        origin: { conversationId: spec.conversationId ?? undefined, jobId: job.id, tool: "media.upscale" },
        derivedFrom: source.id,
        note: "Real 2× bilinear resample from the mock provider.",
      });
      return [asset.id];
    });
  }

  async generateVideo(spec: VideoJobSpec): Promise<JobOutcome> {
    if (!this.video.capabilities().generate) {
      throw new MediaUnsupportedError("The active video provider does not support generation.");
    }
    const job = this.createJob("video", "generate", spec.prompt, ["render frames", "encode"], spec.conversationId);
    return this.runJob(job, async (signal, report) => {
      this.setStage(job, "render frames", "running");
      const result = await this.video.generate(
        spec.prompt,
        { durationMs: spec.durationMs ?? 2000, size: Math.min(320, spec.size ?? 256) },
        signal,
        (fraction, detail) => {
          if (fraction < 0.6) report(fraction, "render frames");
          else {
            this.setStage(job, "render frames", "done");
            this.setStage(job, "encode", "running");
            report(fraction, "encode");
          }
          if (detail) job.inputSummary = `${spec.prompt} — ${detail}`;
        },
      );
      this.setStage(job, "encode", "done");
      const asset = await AssetStore.save(
        {
          name: `generated-${this.slug(spec.prompt)}.webm`,
          kind: "video",
          mimeType: "video/webm",
          size: result.blob.size,
          durationMs: result.durationMs,
          source: "generated",
          origin: { conversationId: spec.conversationId ?? undefined, jobId: job.id, tool: "video.generate" },
          derivedFrom: null,
          prompt: spec.prompt,
          note: `Mock clip: ${result.frames} procedurally rendered frames. Real video generation arrives in Phase 5.`,
        },
        result.blob,
      );
      return [asset.id];
    });
  }

  async generateAudio(spec: AudioJobSpec): Promise<JobOutcome> {
    if (!this.audio.capabilities().generate) {
      throw new MediaUnsupportedError("The active audio provider does not support generation.");
    }
    const job = this.createJob("audio", "generate", spec.prompt, ["synthesize", "encode"], spec.conversationId);
    return this.runJob(job, async (signal, report) => {
      this.setStage(job, "synthesize", "running");
      const result = await this.audio.generate(spec.prompt, spec.durationMs ?? 3000, signal, (fraction, detail) => {
        if (fraction < 0.7) report(fraction * 0.7, "synthesize");
        else {
          this.setStage(job, "synthesize", "done");
          this.setStage(job, "encode", "running");
          report(0.7 + (fraction - 0.7), "encode");
        }
        if (detail) job.inputSummary = `${spec.prompt} — ${detail}`;
      });
      this.setStage(job, "encode", "done");
      const asset = await AssetStore.save(
        {
          name: `generated-${this.slug(spec.prompt)}.wav`,
          kind: "audio",
          mimeType: "audio/wav",
          size: result.blob.size,
          durationMs: result.durationMs,
          source: "generated",
          origin: { conversationId: spec.conversationId ?? undefined, jobId: job.id, tool: "audio.generate" },
          derivedFrom: null,
          prompt: spec.prompt,
          note: "Deterministic mock synthesis (real PCM). Real models bring TTS and richer audio in Phase 5.",
        },
        result.blob,
      );
      return [asset.id];
    });
  }

  /** Explicit refusal helper for capabilities mocks don't support. */
  async transcribe(): Promise<never> {
    return (this.audio as MockAudioProvider).transcribe();
  }

  async speak(): Promise<never> {
    return (this.audio as MockAudioProvider).tts();
  }
}

/* Decode an image blob to pixels (injected decoder off-browser). */
async function decodeAssetToSurface(blob: Blob, injected?: (blob: Blob) => Promise<PixelSurface>): Promise<PixelSurface> {
  if (injected) return injected(blob);
  if (typeof createImageBitmap === "undefined" || typeof document === "undefined") {
    throw new Error("Image decoding requires a browser environment (covered by E2E).");
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable.");
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { width: imageData.width, height: imageData.height, data: imageData.data };
}

export const mediaEngine = new MediaEngine();
