import type { Conversation, MemoryEntry, Message, Project, RuntimeTask, Settings, WorkspaceStats } from "@/lib/types";
import { downloadText } from "@/lib/utils";
import { AssetStore } from "./AssetStore";
import { ConversationStore } from "./ConversationStore";
import { FileStore } from "./FileStore";
import { MediaJobStore } from "./MediaJobStore";
import { MemoryStore } from "./MemoryStore";
import { ProjectStore } from "./ProjectStore";
import { SettingsStore } from "./SettingsStore";
import { TaskStore } from "./TaskStore";
import { STORES, idbClear, idbCount, idbGetAll } from "./db";

export { AssetStore, ConversationStore, FileStore, MediaJobStore, MemoryStore, ProjectStore, SettingsStore, TaskStore };

export async function workspaceStats(): Promise<WorkspaceStats> {
  const [conversations, messages, files, bytes, assets, mediaBytes] = await Promise.all([
    idbCount(STORES.conversations),
    idbCount(STORES.messages),
    idbCount(STORES.files),
    FileStore.totalBytes(),
    idbCount(STORES.assets),
    AssetStore.totalBytes(),
  ]);
  return { conversations, messages, files, bytes, assets, mediaBytes };
}

/** Serializes the entire local workspace to a downloadable JSON file. */
export async function exportWorkspace(): Promise<void> {
  const [settings, projects, conversations, messages, files, tasks, memory, assets, mediaJobs] = await Promise.all([
    SettingsStore.get(),
    ProjectStore.list(),
    idbGetAll<Conversation>(STORES.conversations),
    idbGetAll<Message>(STORES.messages),
    FileStore.list(),
    idbGetAll<RuntimeTask>(STORES.tasks),
    idbGetAll<MemoryEntry>(STORES.memory),
    AssetStore.list(),
    MediaJobStore.list(),
  ]);
  const payload = {
    app: "aether",
    phase: 4,
    exportedAt: new Date().toISOString(),
    settings,
    projects,
    conversations,
    messages,
    files, // metadata only — binary blobs are not serialized
    tasks,
    memory,
    assets, // metadata only
    mediaJobs,
  };
  downloadText(`aether-workspace-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2));
}

/** Removes every record from the local workspace. */
export async function wipeWorkspace(): Promise<void> {
  await FileStore.clear();
  await AssetStore.clear();
  await idbClear(STORES.conversations);
  await idbClear(STORES.messages);
  await idbClear(STORES.projects);
  await idbClear(STORES.settings);
  await idbClear(STORES.tasks);
  await idbClear(STORES.memory);
  await idbClear(STORES.mediaJobs);
}
