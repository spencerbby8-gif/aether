import type { MediaCapabilities } from "@/lib/types";
import {
  applyEditOp,
  createSurface,
  decodeWav,
  editKeywordsNote,
  encodeWav,
  enhance as enhanceOp,
  generateArt,
  hashSeed,
  parseEditOps,
  synthesizeAudio,
  upscale as upscaleOp,
  type PixelSurface,
} from "./codec";

/**
 * Media provider contracts + Phase 4 mock implementations.
 * Mocks produce REAL artifacts (genuine PNG/WAV bytes, real pixel math) and
 * declare exactly what they support — unsupported capabilities raise
 * MediaUnsupportedError instead of faking output. The remote Kaggle agent
 * (Phase 5) implements these same interfaces.
 */

export class MediaUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaUnsupportedError";
  }
}

export type ProgressFn = (fraction: number, detail?: string) => void;

/* ---------------- image ---------------- */

export interface ImageProvider {
  readonly id: string;
  capabilities(): Required<Pick<MediaCapabilities, "generate" | "edit" | "enhance" | "upscale">>;
  generate(prompt: string, size: number, signal: AbortSignal): Promise<PixelSurface>;
  edit(surface: PixelSurface, instruction: string, signal: AbortSignal): Promise<{ surface: PixelSurface; applied: string[] }>;
  enhance(surface: PixelSurface, signal: AbortSignal): Promise<PixelSurface>;
  upscale(surface: PixelSurface, factor: number, signal: AbortSignal): Promise<PixelSurface>;
}

export class MockImageProvider implements ImageProvider {
  readonly id = "mock-image";

  capabilities() {
    return { generate: true, edit: true, enhance: true, upscale: true };
  }

  async generate(prompt: string, size: number, signal: AbortSignal): Promise<PixelSurface> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const surface = createSurface(size, size);
    generateArt(surface, hashSeed(prompt));
    return surface;
  }

  async edit(surface: PixelSurface, instruction: string, signal: AbortSignal): Promise<{ surface: PixelSurface; applied: string[] }> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const ops = parseEditOps(instruction);
    if (ops.length === 0) {
      throw new MediaUnsupportedError(
        `The mock editor found no supported operation in that instruction. Supported: ${editKeywordsNote()}.`,
      );
    }
    let current = surface;
    for (const op of ops) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      current = applyEditOp(current, op);
    }
    return { surface: current, applied: ops };
  }

  async enhance(surface: PixelSurface, signal: AbortSignal): Promise<PixelSurface> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return enhanceOp(surface);
  }

  async upscale(surface: PixelSurface, factor: number, signal: AbortSignal): Promise<PixelSurface> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return upscaleOp(surface, factor);
  }
}

/* ---------------- video ---------------- */

export interface VideoRecorderBackend {
  isSupported(): boolean;
  /** Encode frames into a real video blob. Rejects with AbortError on cancel. */
  record(options: {
    width: number;
    height: number;
    fps: number;
    frames: PixelSurface[];
    signal: AbortSignal;
    onProgress?: ProgressFn;
  }): Promise<{ blob: Blob; durationMs: number }>;
}

export interface VideoProvider {
  readonly id: string;
  capabilities(): MediaCapabilities;
  generate(
    prompt: string,
    options: { durationMs: number; size: number },
    signal: AbortSignal,
    onProgress?: ProgressFn,
  ): Promise<{ blob: Blob; durationMs: number; frames: number }>;
}

export class MockVideoProvider implements VideoProvider {
  readonly id = "mock-video";

  constructor(private recorder: VideoRecorderBackend) {}

  capabilities(): MediaCapabilities {
    /* Honest: the mock renders short generated clips only. */
    return { generate: true, edit: false, enhance: false, upscale: false, trim: false };
  }

  async generate(
    prompt: string,
    options: { durationMs: number; size: number },
    signal: AbortSignal,
    onProgress?: ProgressFn,
  ): Promise<{ blob: Blob; durationMs: number; frames: number }> {
    if (!this.recorder.isSupported()) {
      throw new MediaUnsupportedError(
        "Video recording is not available in this environment. The mock video provider refuses to fake a clip.",
      );
    }
    const seed = hashSeed(prompt);
    const fps = 12;
    const frameCount = Math.max(6, Math.min(36, Math.round((options.durationMs / 1000) * fps)));
    const frames: PixelSurface[] = [];
    for (let i = 0; i < frameCount; i += 1) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const frame = createSurface(options.size, options.size);
      generateArt(frame, seed + i * 7, i);
      frames.push(frame);
      onProgress?.((i + 1) / (frameCount + 2), `Rendering frame ${i + 1}/${frameCount}`);
    }
    const result = await this.recorder.record({
      width: options.size,
      height: options.size,
      fps,
      frames,
      signal,
      onProgress: (fraction, detail) => onProgress?.(0.6 + fraction * 0.4, detail),
    });
    return { ...result, frames: frameCount };
  }
}

/* ---------------- audio ---------------- */

export interface AudioProvider {
  readonly id: string;
  capabilities(): MediaCapabilities;
  generate(prompt: string, durationMs: number, signal: AbortSignal, onProgress?: ProgressFn): Promise<{ blob: Blob; durationMs: number }>;
  trim(wavBytes: Uint8Array, startMs: number, endMs: number, signal: AbortSignal): Promise<{ blob: Blob; durationMs: number }>;
}

export class MockAudioProvider implements AudioProvider {
  readonly id = "mock-audio";

  capabilities(): MediaCapabilities {
    /* Honest: deterministic synthesis + PCM trim. TTS/transcription need a real model. */
    return { generate: true, trim: true, tts: false, transcribe: false };
  }

  async generate(
    prompt: string,
    durationMs: number,
    signal: AbortSignal,
    onProgress?: ProgressFn,
  ): Promise<{ blob: Blob; durationMs: number }> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    onProgress?.(0.2, "Composing waveform");
    const clamped = Math.max(500, Math.min(8_000, durationMs));
    const { samples, sampleRate } = synthesizeAudio(prompt, clamped);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    onProgress?.(0.7, "Encoding WAV");
    const bytes = encodeWav(samples, sampleRate);
    onProgress?.(1, "Done");
    return { blob: new Blob([bytes as unknown as ArrayBuffer], { type: "audio/wav" }), durationMs: clamped };
  }

  async trim(wavBytes: Uint8Array, startMs: number, endMs: number, signal: AbortSignal): Promise<{ blob: Blob; durationMs: number }> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const { samples, sampleRate } = decodeWav(wavBytes);
    const start = Math.max(0, Math.floor((startMs / 1000) * sampleRate));
    const end = Math.min(samples.length, Math.floor((endMs / 1000) * sampleRate));
    if (end <= start) throw new Error("Trim range is empty.");
    const sliced = samples.slice(start, end);
    const bytes = encodeWav(sliced, sampleRate);
    return { blob: new Blob([bytes as unknown as ArrayBuffer], { type: "audio/wav" }), durationMs: Math.round((end - start) / sampleRate * 1000) };
  }

  /* Explicit refusals — never fake these. */
  tts(): never {
    throw new MediaUnsupportedError("Text-to-speech requires the real model (Phase 5). The mock refuses to fake speech.");
  }

  transcribe(): never {
    throw new MediaUnsupportedError("Transcription requires the real model (Phase 5). The mock refuses to fake a transcript.");
  }
}

/* MediaUnsupportedError is exported from the top of this module. */
