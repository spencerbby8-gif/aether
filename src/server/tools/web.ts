import type { ToolResult } from "@/lib/types";
import { ToolSecurityError, assertUrlAllowed, redactSecrets, truncateText } from "./security";

/**
 * WebProvider — controlled web access: fetch, crawl, search, extraction.
 * All URLs pass the host/port guard; redirects are re-validated hop by hop.
 * The fetcher is injectable so crawl/search logic is fully unit-testable.
 */

export interface WebSource {
  url: string;
  title: string;
  snippet: string;
  depth: number;
}

export interface FetchLikeResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal; redirect?: string; headers?: Record<string, string> }) => Promise<FetchLikeResponse>;

const MAX_BODY_CHARS = 512 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = "AetherAgent/3.0 (+sandboxed workspace)";

const defaultFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, {
    redirect: "manual",
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain,*/*;q=0.8", ...(init?.headers ?? {}) },
    signal: init?.signal,
  });
  return {
    status: response.status,
    ok: response.ok,
    headers: { get: (name: string) => response.headers.get(name) },
    text: async () => (await response.text()).slice(0, MAX_BODY_CHARS),
  };
};

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The server-side fetch supports POST + custom UA for search endpoints. */
type SearchFetch = (
  url: string,
  init?: { signal?: AbortSignal; method?: string; body?: string; headers?: Record<string, string> },
) => Promise<FetchLikeResponse>;

const defaultSearchFetch: SearchFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init?.method ?? "GET",
    body: init?.body,
    redirect: "manual",
    headers: { "user-agent": BROWSER_UA, accept: "text/html,*/*;q=0.8", ...(init?.headers ?? {}) },
    signal: init?.signal,
  });
  return {
    status: response.status,
    ok: response.ok,
    headers: { get: (name: string) => response.headers.get(name) },
    text: async () => (await response.text()).slice(0, MAX_BODY_CHARS),
  };
};

export class WebProvider {
  constructor(
    private fetchImpl: FetchLike = defaultFetch,
    private searchFetchImpl: SearchFetch = defaultSearchFetch,
  ) {}

  /** Fetch a URL, following up to 3 re-validated redirects.
      Transient failures (network, timeout, 5xx) are retried with backoff —
      once — so a flaky hop doesn't kill a long-running crawl. */
  async fetchUrl(rawUrl: string): Promise<{ url: string; status: number; contentType: string; body: string }> {
    let current = assertUrlAllowed(rawUrl);
    for (let hop = 0; hop <= 3; hop += 1) {
      let lastError: Error | null = null;
      let response: FetchLikeResponse | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          response = await this.fetchImpl(current, { signal: controller.signal, redirect: "manual" });
          clearTimeout(timer);
          /* Retry only on 5xx / 429 — never on 4xx (deterministic). */
          if (response.status >= 500 || response.status === 429) {
            lastError = new Error(`HTTP ${response.status}`);
            response = null;
            if (attempt === 0) await sleep(400);
            continue;
          }
          break;
        } catch (error) {
          clearTimeout(timer);
          const isAbort = (error as Error)?.name === "AbortError";
          lastError = isAbort
            ? new Error(`Request timed out after ${REQUEST_TIMEOUT_MS} ms.`)
            : new Error((error as Error)?.message ?? "network error");
          response = null;
          if (attempt === 0) await sleep(400); // one healing retry on transient errors
        }
      }
      if (!response) throw new ToolSecurityError(`Request failed: ${lastError?.message ?? "network error"}`);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new ToolSecurityError("Redirect without location.");
        current = assertUrlAllowed(new URL(location, current).toString());
        continue;
      }
      if (!response.ok) throw new ToolSecurityError(`HTTP ${response.status} for ${current}`);
      const contentType = response.headers.get("content-type") ?? "text/plain";
      const body = await response.text();
      return { url: current, status: response.status, contentType, body };
    }
    throw new ToolSecurityError("Too many redirects.");
  }

  async webFetch(args: Record<string, unknown>): Promise<ToolResult> {
    let result: { url: string; status: number; contentType: string; body: string };
    try {
      result = await this.fetchUrl(String(args.url ?? ""));
    } catch (error) {
      /* Deterministic failures (4xx, blocked, timeout) return an honest
         result rather than throwing — the tool contract is always a result. */
      return { ok: false, text: `Fetch failed: ${(error as Error).message}` };
    }
    const asHtml = /html/i.test(result.contentType);
    const text = asHtml ? extractText(result.body) : result.body;
    const title = asHtml ? extractTitle(result.body) : "";
    return {
      ok: true,
      text: truncateText(
        `url: ${result.url}\nstatus: ${result.status}\ntype: ${result.contentType}${title ? `\ntitle: ${title}` : ""}\n---\n${text}`,
        3_000,
      ).text,
    };
  }

  /** BFS crawl with depth/page/request limits and normalized dedupe. */
  async crawl(args: Record<string, unknown>): Promise<{ sources: WebSource[]; pagesVisited: number; requestsMade: number }> {
    const seed = assertUrlAllowed(String(args.url ?? ""));
    const maxDepth = clampInt(args.maxDepth, 1, 2);
    const maxPages = clampInt(args.maxPages, 1, 8);
    const maxRequests = clampInt(args.maxRequests, 1, 16);

    const seen = new Set<string>([normalizeUrl(seed)]);
    const queue: Array<{ url: string; depth: number }> = [{ url: seed, depth: 0 }];
    const sources: WebSource[] = [];
    let requestsMade = 0;
    let pagesVisited = 0;

    while (queue.length > 0 && pagesVisited < maxPages && requestsMade < maxRequests) {
      const item = queue.shift();
      if (!item) break;
      requestsMade += 1;
      let result: { url: string; body: string; contentType: string };
      try {
        const fetched = await this.fetchUrl(item.url);
        result = fetched;
      } catch {
        continue; // unreachable pages are skipped, not fatal
      }
      if (!/html/i.test(result.contentType)) continue;
      pagesVisited += 1;

      const title = extractTitle(result.body);
      const text = extractText(result.body);
      sources.push({
        url: result.url,
        title: title || result.url,
        snippet: text.replace(/\s+/g, " ").trim().slice(0, 200),
        depth: item.depth,
      });

      if (item.depth < maxDepth) {
        for (const link of extractLinks(result.body, result.url)) {
          const normalized = normalizeUrl(link);
          if (!normalized || seen.has(normalized) || seen.size >= maxRequests * 2) continue;
          try {
            assertUrlAllowed(normalized);
          } catch {
            continue;
          }
          seen.add(normalized);
          queue.push({ url: normalized, depth: item.depth + 1 });
        }
      }
    }

    return { sources, pagesVisited, requestsMade };
  }

  async webCrawl(args: Record<string, unknown>): Promise<ToolResult> {
    const { sources, pagesVisited, requestsMade } = await this.crawl(args);
    if (sources.length === 0) return { ok: false, text: "Crawl produced no readable pages." };
    const lines = sources.map(
      (s) => `- [depth ${s.depth}] ${s.title}\n  ${s.url}\n  ${s.snippet.slice(0, 140)}`,
    );
    return {
      ok: true,
      text: truncateText(`Crawled ${pagesVisited} page(s) with ${requestsMade} request(s).\n${lines.join("\n")}`, 3_000).text,
    };
  }

  /**
   * Web search with healing. DuckDuckGo actively bot-blocks server clients
   * (TLS fingerprinting → 202/302/403), so a single fragile request is not
   * enough. This tries a chain of strategies with retries and alternate
   * endpoints, and degrades honestly if the provider blocks every attempt.
   * No fake results are ever fabricated.
   */
  async webSearch(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, text: "A query is required." };

    const strategies: Array<{ label: string; run: () => Promise<string> }> = [
      {
        label: "ddg-html-get",
        run: async () => (await this.fetchUrl(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`)).body,
      },
      {
        label: "ddg-html-post",
        run: () =>
          this.searchPost("https://html.duckduckgo.com/html/", new URLSearchParams({ q: query }).toString()),
      },
      {
        label: "ddg-lite-post",
        run: () =>
          this.searchPost("https://lite.duckduckgo.com/lite/", new URLSearchParams({ q: query }).toString()),
      },
    ];

    let lastError = "search provider unreachable";
    for (const strategy of strategies) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const html = await strategy.run();
          const sources = parseDuckDuckGo(html).slice(0, 5);
          if (sources.length > 0) {
            const lines = sources.map((s, i) => `${i + 1}. ${s.title}\n   ${s.url}\n   ${s.snippet}`);
            return { ok: true, text: truncateText(lines.join("\n"), 2_500).text };
          }
          lastError = `${strategy.label}: blocked or no parseable results`;
        } catch (error) {
          lastError = `${strategy.label}: ${(error as Error).message}`;
        }
        if (attempt === 0) await sleep(500); // heal: brief backoff before retry
      }
    }
    return {
      ok: false,
      text: `Web search unavailable right now (${lastError}). The search provider is blocking automated requests; try again shortly or use fetch_page with a known URL.`,
    };
  }

  /** POST a search form to an HTML endpoint with a browser-like profile. */
  private async searchPost(url: string, formBody: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.searchFetchImpl(url, {
        signal: controller.signal,
        method: "POST",
        body: formBody,
        headers: { "content-type": "application/x-www-form-urlencoded", referer: "https://duckduckgo.com/" },
      });
      if (!response.ok) throw new ToolSecurityError(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw new ToolSecurityError(`Request timed out after ${REQUEST_TIMEOUT_MS} ms.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ---------------- html helpers (dependency-free) ---------------- */

export function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? decodeEntities(match[1]).replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

export function extractText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = withoutScripts.replace(/<[^>]+>/g, " ");
  return redactSecrets(decodeEntities(text)).replace(/\s+/g, " ").trim();
}

export function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const pattern = /<a\s[^>]*href\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null && links.length < 50) {
    const href = match[1].trim();
    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;
    try {
      links.push(new URL(href, baseUrl).toString());
    } catch {
      /* relative garbage — skip */
    }
  }
  return links;
}

/** Canonical form for duplicate detection. */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    url.pathname = pathname || "/";
    return url.protocol + "//" + url.hostname.toLowerCase() + (url.port ? `:${url.port}` : "") + url.pathname + url.search;
  } catch {
    return "";
  }
}

/** Unwrap DuckDuckGo redirect links (uddg=) to the real target URL. */
function unwrapDdgHref(href: string): string {
  const wrapped = /uddg=([^&]+)/.exec(href);
  if (wrapped) {
    try {
      return decodeURIComponent(wrapped[1]);
    } catch {
      return href;
    }
  }
  return href;
}

/** Extract the href attribute from an <a> tag regardless of attribute order. */
function hrefFromTag(tag: string): string {
  const match = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
  return match ? match[1] : "";
}

/** Parse the full HTML endpoint (result__a / result__snippet). */
function parseDdgHtml(html: string): WebSource[] {
  const sources: WebSource[] = [];
  /* Match each result__a anchor tag plus everything until the next result. */
  const itemPattern = /<a\b[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*class="result__a"|<\/body>)/gi;
  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(html)) !== null && sources.length < 8) {
    const tag = match[0].slice(0, match[0].indexOf(">") + 1);
    const url = unwrapDdgHref(decodeEntities(hrefFromTag(tag)));
    const title = decodeEntities(match[1].replace(/<[^>]+>/g, "")).trim();
    const snippetMatch = /class="result__snippet"[^>]*>([\s\S]*?)(?:<\/a>|<\/div>)/i.exec(match[2]);
    const snippet = snippetMatch ? decodeEntities(snippetMatch[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : "";
    if (url.startsWith("http") && title) sources.push({ url, title, snippet, depth: 0 });
  }
  return sources;
}

/** Parse the lite endpoint (result-link anchors / result-snippet cells). */
function parseDdgLite(html: string): WebSource[] {
  const sources: WebSource[] = [];
  const snippets = [...html.matchAll(/class="result-snippet"[^>]*>([\s\S]*?)(?:<\/td>|<\/a>)/gi)].map((m) =>
    decodeEntities(m[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
  );
  const anchorPattern = /<a\b[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = anchorPattern.exec(html)) !== null && sources.length < 8) {
    const tag = match[0].slice(0, match[0].indexOf(">") + 1);
    const url = unwrapDdgHref(decodeEntities(hrefFromTag(tag)));
    const title = decodeEntities(match[1].replace(/<[^>]+>/g, "")).trim();
    if (url.startsWith("http") && title) {
      sources.push({ url, title, snippet: snippets[index] ?? "", depth: 0 });
    }
    index += 1;
  }
  return sources;
}

/** Detect which DuckDuckGo layout is present and parse accordingly. */
export function parseDuckDuckGo(html: string): WebSource[] {
  if (/class="result__a"/i.test(html)) return parseDdgHtml(html);
  if (/class="result-link"/i.test(html)) return parseDdgLite(html);
  /* Some responses mix classes — try both and return whichever yields. */
  return parseDdgHtml(html).length > 0 ? parseDdgHtml(html) : parseDdgLite(html);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function clampInt(value: unknown, min: number, max: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(max, parsed));
}
