import type { AttachmentKind } from "@/lib/types";
import { STORES, idbClear, idbDelete, idbGet, idbGetAll, idbPut } from "./db";

export interface StoredFile {
  id: string;
  kind: AttachmentKind;
  name: string;
  mimeType: string;
  size: number;
  blob: Blob;
  createdAt: number;
}

const urlCache = new Map<string, string>();

/** Persistence for attachments, pasted images and dropped files (as Blobs). */
export const FileStore = {
  async save(file: Omit<StoredFile, "createdAt">): Promise<StoredFile> {
    const record: StoredFile = { ...file, createdAt: Date.now() };
    await idbPut(STORES.files, record);
    return record;
  },

  async get(id: string): Promise<StoredFile | undefined> {
    return idbGet<StoredFile>(STORES.files, id);
  },

  async list(): Promise<Array<Omit<StoredFile, "blob">>> {
    const all = await idbGetAll<StoredFile>(STORES.files);
    return all
      .map(({ blob: _blob, ...meta }) => meta)
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  async remove(id: string): Promise<void> {
    const url = urlCache.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      urlCache.delete(id);
    }
    await idbDelete(STORES.files, id);
  },

  async totalBytes(): Promise<number> {
    const all = await idbGetAll<StoredFile>(STORES.files);
    return all.reduce((sum, file) => sum + file.size, 0);
  },

  /** Lazily resolved object URL for previews. */
  async urlFor(id: string): Promise<string | null> {
    const cached = urlCache.get(id);
    if (cached) return cached;
    const record = await this.get(id);
    if (!record) return null;
    const url = URL.createObjectURL(record.blob);
    urlCache.set(id, url);
    return url;
  },

  revokeAll(): void {
    for (const url of urlCache.values()) URL.revokeObjectURL(url);
    urlCache.clear();
  },

  async clear(): Promise<void> {
    this.revokeAll();
    await idbClear(STORES.files);
  },
};
