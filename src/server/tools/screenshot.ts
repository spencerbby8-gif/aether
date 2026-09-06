import { promises as fs } from "node:fs";
import { signArtifactUrl } from "@/server/auth";
import path from "node:path";
import type { ToolResult } from "@/lib/types";
import { ToolSecurityError, WORKSPACE_ROOT, assertUrlAllowed, redactSecrets, shortId } from "./security";

/**
 * Page screenshots via headless Chromium (Playwright).
 * The browser starts lazily on first use and is shared across calls.
 * Allowed targets: guarded http(s) URLs, plus data:text/html (no network).
 */

type BrowserLike = {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
};
type PageLike = {
  goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  title(): Promise<string>;
  screenshot(options?: { type?: "png"; fullPage?: boolean }): Promise<Buffer>;
  close(): Promise<void>;
};

let browserPromise: Promise<BrowserLike> | null = null;

async function getBrowser(): Promise<BrowserLike> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import("playwright");
      return (await chromium.launch({ headless: true })) as unknown as BrowserLike;
    })().catch((error) => {
      /* Never cache a failed launch — retry on the next call. */
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}

function assertTargetAllowed(raw: string): string {
  if (raw.startsWith("data:text/html")) {
    if (raw.length > 200_000) throw new ToolSecurityError("data: URL too large.");
    return raw;
  }
  /* Full host/port validation via the shared guard. */
  return assertUrlAllowed(raw);
}

export async function webScreenshot(args: Record<string, unknown>, taskId: string): Promise<ToolResult> {
  const url = String(args.url ?? "");
  if (!url) return { ok: false, text: "A url is required." };
  const target = assertTargetAllowed(url);

  const artifactDir = path.join(WORKSPACE_ROOT, "artifacts", taskId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default");
  await fs.mkdir(artifactDir, { recursive: true });

  const started = Date.now();
  let page: PageLike | null = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.goto(target, { timeout: 20_000, waitUntil: "load" });
    const title = await page.title().catch(() => "");
    const buffer = await page.screenshot({ type: "png" });
    const id = shortId("shot");
    const fileName = `${id}.png`;
    await fs.writeFile(path.join(artifactDir, fileName), buffer);
    const artifact = {
      id: `${path.basename(artifactDir)}/${fileName}`,
      name: fileName,
      mimeType: "image/png",
      size: buffer.byteLength,
      /* Signed + expiring: media tags cannot carry an Authorization header. */
      url: signArtifactUrl(`${path.basename(artifactDir)}/${fileName}`),
    };
    return {
      ok: true,
      text: `Screenshot of ${target}${title ? ` — "${redactSecrets(title)}"` : ""} (${Math.round(buffer.byteLength / 1024)} KB, ${Date.now() - started} ms).\nartifact: ${artifact.url}`,
      artifacts: [artifact],
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, text: `Screenshot failed: ${(error as Error)?.message ?? "unknown error"}` };
  } finally {
    await page?.close().catch(() => {});
  }
}
