import type { AgentEvent, AttachmentKind, AttachmentMeta } from "@/lib/types";
import { uid } from "@/lib/utils";
import { FileStore } from "@/storage";
import type { AIProvider, ProviderDescriptor } from "./types";

export type { AIProvider, ProviderDescriptor };

/* ------------------------------------------------------------------ */
/* StreamingProvider — decodes the SSE wire format into AgentEvents.   */
/* (Retained for protocol compatibility; real chat streams NDJSON via  */
/* /api/agent/stream — see src/providers/engine-chat.ts.)              */
/* ------------------------------------------------------------------ */

export class StreamingProvider {
  static async *decode(stream: ReadableStream<Uint8Array>): AsyncGenerator<AgentEvent> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try {
            const event = JSON.parse(line.slice(5).trim()) as AgentEvent;
            if (event && typeof event.type === "string") yield event;
          } catch {
            // Ignore malformed frames — the protocol must never crash the UI.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  static encode(event: AgentEvent): string {
    return `data: ${JSON.stringify(event)}\n\n`;
  }
}

/* ------------------------------------------------------------------ */
/* MediaProvider — turns pasted / dropped / picked files into stored   */
/* attachments, and resolves preview URLs.                             */
/* ------------------------------------------------------------------ */

const MAX_FILE_BYTES = 8 * 1024 * 1024;

function classifyKind(mime: string): AttachmentKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

export const MediaProvider = {
  async fromFile(file: File): Promise<AttachmentMeta | { error: string }> {
    if (file.size > MAX_FILE_BYTES) {
      return { error: `"${file.name}" is over the 8 MB attachment limit.` };
    }
    const id = uid();
    /* Accept ANY file type the browser can hand us — classify for preview
       where possible, but never reject an unfamiliar MIME. */
    const mime = file.type || "application/octet-stream";
    const kind = classifyKind(mime);
    const fallbackName =
      kind === "image" ? "pasted-image.png" : kind === "video" ? "video.webm" : kind === "audio" ? "audio.wav" : "attachment";
    const name = file.name || fallbackName;
    await FileStore.save({ id, kind, name, mimeType: mime, size: file.size, blob: file });
    return { id, kind, name, mimeType: mime, size: file.size };
  },

  async fromFiles(files: Iterable<File>): Promise<AttachmentMeta[]> {
    const metas: AttachmentMeta[] = [];
    for (const file of files) {
      const result = await this.fromFile(file);
      if ("error" in result) {
        const { toast } = await import("@/lib/utils");
        toast(result.error, "danger");
      } else {
        metas.push(result);
      }
    }
    return metas;
  },

  async fromDataTransfer(dataTransfer: DataTransfer): Promise<AttachmentMeta[]> {
    return this.fromFiles(Array.from(dataTransfer.files));
  },

  async fromClipboard(clipboardData: DataTransfer | null): Promise<AttachmentMeta[]> {
    if (!clipboardData) return [];
    const files = Array.from(clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    return this.fromFiles(files);
  },

  urlFor(attachmentId: string): Promise<string | null> {
    return FileStore.urlFor(attachmentId);
  },
};
