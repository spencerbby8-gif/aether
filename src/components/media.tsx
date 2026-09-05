"use client";

import { useCallback, useEffect, useState } from "react";
import type { MediaAssetMeta, MediaJob, MediaJobStatus } from "@/lib/types";
import { cn, formatBytes, timeAgo, toast } from "@/lib/utils";
import { mediaEngine } from "@/media/engine";
import { AssetStore } from "@/storage/AssetStore";
import { MediaJobStore } from "@/storage/MediaJobStore";
import { Icon } from "./icons";
import { StatusChip } from "./agent-ui";

/* ---------------- lightbox ---------------- */

interface LightboxRequest {
  assetId: string;
}

/** Opens the fullscreen media viewer for an asset. */
export function openLightbox(assetId: string): void {
  window.dispatchEvent(new CustomEvent<LightboxRequest>("aether:lightbox", { detail: { assetId } }));
}

export function MediaLightbox() {
  const [assetId, setAssetId] = useState<string | null>(null);
  const [asset, setAsset] = useState<(Omit<MediaAssetMeta, never> & { url: string | null }) | null>(null);
  const [beforeUrl, setBeforeUrl] = useState<string | null>(null);
  const [split, setSplit] = useState(50);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<LightboxRequest>).detail;
      setAssetId(detail.assetId);
      setSplit(50);
    };
    window.addEventListener("aether:lightbox", onOpen);
    return () => window.removeEventListener("aether:lightbox", onOpen);
  }, []);

  useEffect(() => {
    if (!assetId) return;
    let cancelled = false;
    setAsset(null);
    setBeforeUrl(null);
    AssetStore.get(assetId).then(async (record) => {
      if (cancelled || !record) return;
      const { blob, ...meta } = record;
      const url = await AssetStore.urlFor(assetId);
      if (cancelled) return;
      setAsset({ ...meta, url });
      if (meta.derivedFrom) {
        const before = await AssetStore.urlFor(meta.derivedFrom);
        if (!cancelled) setBeforeUrl(before);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAssetId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const regenerate = async () => {
    if (!asset?.prompt || busy) return;
    setBusy(true);
    try {
      await mediaEngine.generateImage({ prompt: asset.prompt, conversationId: asset.origin?.conversationId ?? null });
      toast("New variation generated — see the Workspace media tab", "ok");
    } finally {
      setBusy(false);
    }
  };

  if (!assetId) return null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-ink-950/95 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Media viewer">
      <div className="flex h-[54px] shrink-0 items-center justify-between gap-3 border-b border-line px-4">
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-medium text-fog-100">{asset?.name ?? "…"}</p>
          {asset?.note ? <p className="truncate text-[11px] text-fog-500">{asset.note}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {asset?.source === "generated" && asset.prompt ? (
            <button
              type="button"
              onClick={() => void regenerate()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1.5 text-[12px] text-fog-300 transition-colors hover:bg-ink-800 disabled:opacity-50"
            >
              <Icon name="refresh" size={12} />
              {busy ? "Generating…" : "Regenerate"}
            </button>
          ) : null}
          {asset?.url ? (
            <a
              href={asset.url}
              download={asset.name}
              className="flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1.5 text-[12px] text-fog-300 transition-colors hover:bg-ink-800"
            >
              <Icon name="download" size={12} />
              Download
            </a>
          ) : null}
          <button
            type="button"
            onClick={() => setAssetId(null)}
            className="rounded-lg p-2 text-fog-400 transition-colors hover:bg-ink-800 hover:text-fog-100"
            aria-label="Close viewer"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6">
        {asset?.kind === "image" && asset.url ? (
          beforeUrl ? (
            /* before/after comparison slider */
            <div
              className="relative h-full max-h-[70vh] max-w-full select-none"
              style={{ aspectRatio: `${asset.width ?? 1} / ${asset.height ?? 1}` }}
            >
              <img src={beforeUrl} alt="Before" className="absolute inset-0 h-full w-full rounded-xl object-contain" draggable={false} />
              <div className="absolute inset-0 overflow-hidden rounded-xl" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
                <img src={asset.url} alt="After" className="h-full w-full object-contain" draggable={false} />
              </div>
              <div className="pointer-events-none absolute inset-y-0 border-r border-ember-400/80" style={{ left: `${split}%` }} />
              <span className="absolute left-2 top-2 rounded bg-ink-950/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fog-300">
                Edited
              </span>
              <span className="absolute right-2 top-2 rounded bg-ink-950/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fog-300">
                Original
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={split}
                onChange={(e) => setSplit(Number(e.target.value))}
                className="absolute inset-x-0 bottom-3 mx-auto block h-1.5 w-2/3 cursor-pointer accent-[#e2b161]"
                aria-label="Before/after comparison"
              />
            </div>
          ) : (
            <img src={asset.url} alt={asset.name} className="max-h-full max-w-full rounded-xl object-contain" />
          )
        ) : asset?.kind === "video" && asset.url ? (
          <video src={asset.url} controls autoPlay loop className="max-h-full max-w-full rounded-xl" />
        ) : asset?.kind === "audio" && asset.url ? (
          <div className="w-full max-w-md rounded-xl border border-line bg-ink-850 p-6">
            <Icon name="sparkle" size={18} className="text-ember-400" />
            <p className="mt-2 text-[13px] text-fog-300">{asset.name}</p>
            <audio src={asset.url} controls className="mt-3 w-full" />
          </div>
        ) : (
          <div className="skeleton h-64 w-64" />
        )}
      </div>

      {asset ? (
        <div className="flex shrink-0 items-center justify-center gap-3 border-t border-line px-4 py-2 text-[11px] text-fog-500">
          <span>{asset.kind}</span>
          <span aria-hidden="true">·</span>
          <span>{formatBytes(asset.size)}</span>
          {asset.width && asset.height ? (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {asset.width}×{asset.height}
              </span>
            </>
          ) : null}
          {asset.durationMs ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{(asset.durationMs / 1000).toFixed(1)}s</span>
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <span className="capitalize">{asset.source}</span>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- workspace media tab ---------------- */

const JOB_STATUS_CHIP: Record<MediaJobStatus, "planning" | "running" | "completed" | "failed" | "cancelled"> = {
  queued: "planning",
  processing: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

export function WorkspaceMedia({ refreshKey }: { refreshKey: number }) {
  const [assets, setAssets] = useState<Array<Omit<MediaAssetMeta, never>>>([]);
  const [jobs, setJobs] = useState<MediaJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<"all" | "image" | "video" | "audio">("all");
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    const [assetList, jobList] = await Promise.all([AssetStore.list().catch(() => []), MediaJobStore.list().catch(() => [])]);
    setAssets(assetList);
    setJobs(jobList);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  /* Live job progress from the engine. */
  useEffect(() => {
    const unsubscribe = mediaEngine.subscribe((job) => {
      setJobs((prev) => {
        const next = prev.filter((j) => j.id !== job.id);
        return [job, ...next].slice(0, 30);
      });
      if (job.status === "completed") void reload();
    });
    return unsubscribe;
  }, [reload]);

  useEffect(() => {
    /* Resolve thumbnail URLs for image assets. */
    let cancelled = false;
    for (const asset of assets) {
      if (asset.kind !== "image" || thumbs[asset.id]) continue;
      void AssetStore.urlFor(asset.id).then((url) => {
        if (!cancelled && url) {
          setThumbs((prev) => (prev[asset.id] ? prev : { ...prev, [asset.id]: url }));
        }
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets]);

  const removeAsset = async (id: string) => {
    await AssetStore.remove(id);
    setThumbs((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    toast("Asset deleted");
    void reload();
  };

  const removeJob = async (id: string) => {
    await MediaJobStore.remove(id);
    setJobs((prev) => prev.filter((j) => j.id !== id));
  };

  const visible = filter === "all" ? assets : assets.filter((a) => a.kind === filter);

  return (
    <div>
      {/* jobs */}
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fog-600">Media jobs</h3>
      </div>
      {jobs.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-fog-600">
          No media jobs yet. Ask the agent to draw, generate audio or render a video in chat.
        </p>
      ) : (
        <div className="mt-2 overflow-hidden rounded-xl border border-line bg-ink-850">
          {jobs.slice(0, 8).map((job, index) => (
            <div key={job.id} className={cn("group px-3.5 py-2.5", index > 0 && "border-t border-line")}>
              <div className="flex items-center gap-3">
                <Icon
                  name={job.kind === "image" ? "image" : job.kind === "video" ? "play" : "sparkle"}
                  size={13}
                  className="shrink-0 text-fog-500"
                />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-fog-300">
                  {job.operation} — {job.inputSummary}
                </span>
                <StatusChip status={JOB_STATUS_CHIP[job.status]} />
                {job.status === "processing" || job.status === "queued" ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (mediaEngine.cancel(job.id)) toast("Job cancelling…");
                    }}
                    className="shrink-0 rounded-md p-1 text-fog-600 transition-colors hover:bg-danger-400/15 hover:text-danger-400"
                    aria-label="Cancel job"
                  >
                    <Icon name="x" size={12} />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void removeJob(job.id)}
                    className="shrink-0 rounded-md p-1 text-fog-600 opacity-0 transition-all hover:bg-ink-700 hover:text-fog-300 group-hover:opacity-100"
                    aria-label="Dismiss job"
                  >
                    <Icon name="x" size={12} />
                  </button>
                )}
              </div>
              {job.status === "processing" ? (
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink-700">
                  <div className="h-full rounded-full bg-ember-400 transition-all duration-300" style={{ width: `${job.progress}%` }} />
                </div>
              ) : null}
              {job.status === "failed" && job.error ? (
                <p className="mt-1.5 text-[11.5px] text-danger-400">{job.error}</p>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {/* assets */}
      <div className="mt-6 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fog-600">Assets</h3>
        <div className="flex gap-1">
          {(["all", "image", "video", "audio"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => setFilter(kind)}
              className={cn(
                "rounded-lg border px-2 py-1 text-[11px] font-medium capitalize transition-colors",
                filter === kind
                  ? "border-ember-400/45 bg-ember-400/10 text-ember-300"
                  : "border-line bg-ink-850 text-fog-500 hover:text-fog-300",
              )}
            >
              {kind}
            </button>
          ))}
        </div>
      </div>

      {!loaded ? (
        <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="skeleton aspect-square rounded-xl" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-fog-500">
          No {filter === "all" ? "" : `${filter} `}assets yet — generated and uploaded media appears here and stays
          reusable across conversations.
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {visible.map((asset) => (
            <div key={asset.id} className="group relative">
              <button
                type="button"
                onClick={() => openLightbox(asset.id)}
                className="block w-full overflow-hidden rounded-xl border border-line bg-ink-850 transition-colors hover:border-line-strong"
                aria-label={`Open ${asset.name}`}
              >
                {asset.kind === "image" ? (
                  <img src={thumbs[asset.id]} alt={asset.name} className="aspect-square w-full object-cover" />
                ) : (
                  <span className="flex aspect-square w-full flex-col items-center justify-center gap-1.5 text-fog-500">
                    <Icon name={asset.kind === "video" ? "play" : "sparkle"} size={20} />
                    <span className="px-2 text-[10.5px] leading-tight text-fog-600">
                      {asset.durationMs ? `${(asset.durationMs / 1000).toFixed(1)}s` : asset.kind}
                    </span>
                  </span>
                )}
              </button>
              <div className="pointer-events-none absolute inset-x-0 bottom-0 rounded-b-xl bg-gradient-to-t from-ink-950/90 to-transparent p-1.5 pt-4 opacity-0 transition-opacity group-hover:opacity-100">
                <p className="truncate text-[10px] text-fog-300">{asset.name}</p>
              </div>
              <button
                type="button"
                onClick={() => void removeAsset(asset.id)}
                className="absolute right-1 top-1 rounded-md bg-ink-950/80 p-1 text-fog-400 opacity-0 transition-all hover:text-danger-400 group-hover:opacity-100"
                aria-label={`Delete ${asset.name}`}
              >
                <Icon name="trash" size={11} />
              </button>
              <span className="absolute left-1 top-1 rounded bg-ink-950/80 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-fog-400">
                {asset.source === "uploaded" ? "source" : asset.source}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
