/**
 * Minimal promise-based IndexedDB wrapper.
 * All Aether workspace data lives here — no remote database.
 */

const DB_NAME = "aether-workspace";
const DB_VERSION = 3;

export const STORES = {
  conversations: "conversations",
  messages: "messages",
  projects: "projects",
  files: "files",
  settings: "settings",
  tasks: "tasks",
  memory: "memory",
  assets: "assets",
  mediaJobs: "mediaJobs",
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    /* Multi-tab safety: another tab may hold an older connection. */
    request.onblocked = () => {
      console.warn("Aether workspace upgrade is blocked by another open tab — close other Aether tabs.");
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.conversations)) {
        db.createObjectStore(STORES.conversations, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORES.messages)) {
        const store = db.createObjectStore(STORES.messages, { keyPath: "id" });
        store.createIndex("byConversation", "conversationId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.projects)) {
        db.createObjectStore(STORES.projects, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORES.files)) {
        db.createObjectStore(STORES.files, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings);
      }
      if (!db.objectStoreNames.contains(STORES.tasks)) {
        const tasks = db.createObjectStore(STORES.tasks, { keyPath: "id" });
        tasks.createIndex("byConversation", "conversationId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.memory)) {
        const memory = db.createObjectStore(STORES.memory, { keyPath: "id" });
        memory.createIndex("byScope", "scope", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.assets)) {
        const assets = db.createObjectStore(STORES.assets, { keyPath: "id" });
        assets.createIndex("byKind", "kind", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.mediaJobs)) {
        db.createObjectStore(STORES.mediaJobs, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      /* If a newer tab upgrades the schema, release our connection so the
         upgrade can proceed; our next operation reopens lazily. */
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB."));
  });
  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDB();
  return requestToPromise(db.transaction(store, "readonly").objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDB();
  return requestToPromise(db.transaction(store, "readonly").objectStore(store).get(key) as IDBRequest<T | undefined>);
}

export async function idbGetAllByIndex<T>(store: StoreName, index: string, key: IDBValidKey): Promise<T[]> {
  const db = await openDB();
  return requestToPromise(
    db.transaction(store, "readonly").objectStore(store).index(index).getAll(key) as IDBRequest<T[]>,
  );
}

export async function idbPut(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(store, "readwrite");
  const target = tx.objectStore(store);
  requestToPromise(key === undefined ? target.put(value) : target.put(value, key));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed."));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted."));
  });
}

export async function idbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(store, "readwrite");
  requestToPromise(tx.objectStore(store).delete(key));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed."));
  });
}

export async function idbClear(store: StoreName): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(store, "readwrite");
  requestToPromise(tx.objectStore(store).clear());
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB clear failed."));
  });
}

export async function idbCount(store: StoreName): Promise<number> {
  const db = await openDB();
  return requestToPromise(db.transaction(store, "readonly").objectStore(store).count());
}
