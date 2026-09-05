import type { MediaAssetMeta, MediaKind } from "@/lib/types";
import { truncate, uid } from "@/lib/utils";
import { STORES, idbClear, idbDelete, idbGet, idbGetAll, idbGetAllByIndex, idbPut } from "./db";

export interface StoredAsset extends MediaAssetMeta {
  blob: Blob;
}

const urlCache = new Map<string, string>();

/** Persistence for workspace media assets: sources and generated outputs. */
export const AssetStore = {
  async save(
    meta: Omit<MediaAssetMeta, "id" | "createdAt"> & { id?: string },
    blob: Blob,
  ): Promise<StoredAsset> {
    const record: StoredAsset = {
      ...meta,
      id: meta.id ?? uid(),
      name: truncate(meta.name, 120) || "asset",
      createdAt: Date.now(),
      blob,
    };
    await idbPut(STORES.assets, record);
    return record;
  },

  async get(id: string): Promise<StoredAsset | undefined> {
    return idbGet<StoredAsset>(STORES.assets, id);
  },

  async list(): Promise<Array<Omit<StoredAsset, "blob">>> {
    const all = await idbGetAll<StoredAsset>(STORES.assets);
    return all
      .map(({ blob: _blob, ...meta }) => meta)
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  async byKind(kind: MediaKind): Promise<Array<Omit<StoredAsset, "blob">>> {
    const items = await idbGetAllByIndex<StoredAsset>(STORES.assets, "byKind", kind);
    return items.map(({ blob: _blob, ...meta }) => meta).sort((a, b) => b.createdAt - a.createdAt);
  },

  async remove(id: string): Promise<void> {
    const url = urlCache.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      urlCache.delete(id);
    }
    await idbDelete(STORES.assets, id);
  },

  async totalBytes(): Promise<number> {
    const all = await idbGetAll<StoredAsset>(STORES.assets);
    return all.reduce((sum, asset) => sum + asset.size, 0);
  },

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
    await idbClear(STORES.assets);
  },
};
