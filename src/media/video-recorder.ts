import type { PixelSurface } from "./codec";
import type { ProgressFn, VideoRecorderBackend } from "./providers";

/**
 * Browser video recorder: draws pre-rendered frames to a canvas captured by
 * MediaRecorder, producing a real WebM clip. In environments without
 * MediaRecorder the provider honestly refuses instead of faking output.
 */

class BrowserVideoRecorder implements VideoRecorderBackend {
  isSupported(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof MediaRecorder !== "undefined" &&
      typeof HTMLCanvasElement !== "undefined" &&
      typeof HTMLCanvasElement.prototype.captureStream === "function"
    );
  }

  async record(options: {
    width: number;
    height: number;
    fps: number;
    frames: PixelSurface[];
    signal: AbortSignal;
    onProgress?: ProgressFn;
  }): Promise<{ blob: Blob; durationMs: number }> {
    const canvas = document.createElement("canvas");
    canvas.width = options.width;
    canvas.height = options.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D unavailable.");

    const stream = canvas.captureStream(options.fps);
    const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    return new Promise((resolve, reject) => {
      let cancelled = false;
      const onAbort = () => {
        cancelled = true;
        try {
          recorder.stop();
        } catch {
          /* already stopped */
        }
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });

      recorder.onstop = () => {
        options.signal.removeEventListener("abort", onAbort);
        if (cancelled) return;
        const blob = new Blob(chunks, { type: mimeType ?? "video/webm" });
        resolve({ blob, durationMs: Math.round((options.frames.length / options.fps) * 1000) });
      };
      recorder.onerror = () => {
        options.signal.removeEventListener("abort", onAbort);
        reject(new Error("Video recording failed."));
      };

      recorder.start();
      const frameInterval = 1000 / options.fps;
      let index = 0;
      const imageData = ctx.createImageData(options.width, options.height);

      const drawNext = () => {
        if (cancelled) return;
        if (index >= options.frames.length) {
          setTimeout(() => {
            try {
              recorder.stop();
            } catch {
              /* already stopped */
            }
          }, frameInterval);
          return;
        }
        imageData.data.set(options.frames[index].data);
        ctx.putImageData(imageData, 0, 0);
        index += 1;
        options.onProgress?.(index / options.frames.length, `Recording ${index}/${options.frames.length}`);
        setTimeout(drawNext, frameInterval);
      };
      drawNext();
    });
  }
}

/** Deterministic recorder for tests — proves job flow without a browser. */
export class TestVideoRecorder implements VideoRecorderBackend {
  constructor(private options: { supported?: boolean; waitMs?: number } = {}) {}

  isSupported(): boolean {
    return this.options.supported ?? true;
  }

  async record(opts: {
    frames: PixelSurface[];
    fps: number;
    signal: AbortSignal;
    onProgress?: ProgressFn;
  }): Promise<{ blob: Blob; durationMs: number }> {
    const wait = this.options.waitMs ?? 0;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, wait);
      opts.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
    opts.onProgress?.(1, "encoded");
    const payload = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]); // EBML magic
    return {
      blob: new Blob([payload as unknown as ArrayBuffer], { type: "video/webm" }),
      durationMs: Math.round((opts.frames.length / opts.fps) * 1000),
    };
  }
}

export function createDefaultVideoRecorder(): VideoRecorderBackend {
  return new BrowserVideoRecorder();
}
