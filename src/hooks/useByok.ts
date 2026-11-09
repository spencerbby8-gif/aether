"use client";

import { useCallback, useEffect, useState } from "react";
import type { ByokConnection } from "@/lib/byok";
import { ByokStore } from "@/storage/ByokStore";

export const BYOK_CHANGED_EVENT = "aether:byok-changed";

export function announceByokChanged() {
  window.dispatchEvent(new CustomEvent(BYOK_CHANGED_EVENT));
}

/** Keeps the composer and Settings in sync, including across Aether tabs. */
export function useByokConnections() {
  const [connections, setConnections] = useState<ByokConnection[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setConnections(await ByokStore.list());
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(BYOK_CHANGED_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(BYOK_CHANGED_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [refresh]);

  return { connections, loaded, refresh };
}
