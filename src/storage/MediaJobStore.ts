import type { MediaJob } from "@/lib/types";
import { STORES, idbClear, idbDelete, idbGet, idbGetAll, idbPut } from "./db";

/** Persistence for asynchronous media jobs (generation/editing/synthesis). */
export const MediaJobStore = {
  async save(job: MediaJob): Promise<void> {
    await idbPut(STORES.mediaJobs, { ...job, updatedAt: Date.now() });
  },

  async get(id: string): Promise<MediaJob | undefined> {
    return idbGet<MediaJob>(STORES.mediaJobs, id);
  },

  async list(): Promise<MediaJob[]> {
    const all = await idbGetAll<MediaJob>(STORES.mediaJobs);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  },

  async remove(id: string): Promise<void> {
    await idbDelete(STORES.mediaJobs, id);
  },

  async clear(): Promise<void> {
    await idbClear(STORES.mediaJobs);
  },
};
