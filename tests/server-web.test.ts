import { describe, expect, it } from "vitest";
import { WebProvider, extractLinks, extractText, extractTitle, normalizeUrl, parseDuckDuckGo, type FetchLike } from "@/server/tools/web";

function fakeFetcher(pages: Record<string, { html?: string; status?: number; contentType?: string }>): FetchLike {
  return async (url) => {
    const page = pages[url] ?? pages[normalizeUrl(url)];
    if (!page) {
      return { status: 404, ok: false, headers: { get: () => null }, text: async () => "not found" };
    }
    return {
      status: page.status ?? 200,
      ok: (page.status ?? 200) < 400,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? page.contentType ?? "text/html" : null) },
      text: async () => page.html ?? "",
    };
  };
}

const PAGE_A = `
<html><head><title>Alpha Page</title></head>
<body><script>var hidden = 1;</script>
<h1>Welcome to Alpha</h1><p>Alpha body text here.</p>
<a href="/beta">Beta link</a><a href="https://other.example/gamma?q=1#frag">Gamma</a>
</body></html>`;

const PAGE_B = `<html><head><title>Beta Page</title></head><body><p>Beta body text.</p><a href="/">back home</a></body></html>`;

describe("WebProvider (mocked network)", () => {
  it("fetches and extracts readable content", async () => {
    const provider = new WebProvider(fakeFetcher({ "https://alpha.example/": { html: PAGE_A } }));
    const result = await provider.webFetch({ url: "https://alpha.example/" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("title: Alpha Page");
    expect(result.text).toContain("Alpha body text");
    expect(result.text).not.toContain("hidden"); // scripts stripped
  });

  it("crawls with depth limits, dedupe and normalized sources", async () => {
    const provider = new WebProvider(
      fakeFetcher({
        "https://alpha.example/": { html: PAGE_A },
        "https://alpha.example/beta": { html: PAGE_B },
        "https://other.example/gamma?q=1": { html: "<html><head><title>Gamma</title></head><body>Gamma text.</body></html>" },
      }),
    );
    const { sources, pagesVisited, requestsMade } = await provider.crawl({
      url: "https://alpha.example/",
      maxDepth: 1,
      maxPages: 5,
      maxRequests: 8,
    });
    expect(pagesVisited).toBe(3);
    expect(requestsMade).toBe(3);
    const titles = sources.map((s) => s.title);
    expect(titles).toContain("Alpha Page");
    expect(titles).toContain("Beta Page");
    expect(titles).toContain("Gamma");
    /* Back-link to / must not cause a re-visit. */
    expect(sources.filter((s) => s.title === "Alpha Page")).toHaveLength(1);
  });

  it("respects maxPages and skips unreachable pages without failing", async () => {
    const provider = new WebProvider(fakeFetcher({ "https://alpha.example/": { html: PAGE_A } }));
    const { pagesVisited } = await provider.crawl({ url: "https://alpha.example/", maxDepth: 2, maxPages: 1, maxRequests: 16 });
    expect(pagesVisited).toBe(1);
  });

  it("blocks private targets even through the tool API", async () => {
    const provider = new WebProvider(fakeFetcher({}));
    /* webFetch always returns a ToolResult; blocked targets come back ok:false. */
    const loopback = await provider.webFetch({ url: "http://127.0.0.1/" });
    expect(loopback.ok).toBe(false);
    expect(loopback.text).toMatch(/private|loopback|denied/i);
    const fileScheme = await provider.webFetch({ url: "file:///etc/passwd" });
    expect(fileScheme.ok).toBe(false);
    expect(fileScheme.text).toMatch(/http|denied|allowed/i);
  });
});

describe("HTML helpers", () => {
  it("normalizes URLs for duplicate detection", () => {
    expect(normalizeUrl("https://Example.com/path/#frag")).toBe("https://example.com/path");
    expect(normalizeUrl("https://example.com/path/")).toBe("https://example.com/path");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
    expect(normalizeUrl("garbage")).toBe("");
  });

  it("extracts titles, text and links", () => {
    expect(extractTitle(PAGE_A)).toBe("Alpha Page");
    expect(extractText(PAGE_A)).toContain("Alpha body text");
    const links = extractLinks(PAGE_A, "https://alpha.example/");
    expect(links).toContain("https://alpha.example/beta");
    expect(links).toContain("https://other.example/gamma?q=1#frag");
  });

  it("parses normalized search results", () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffirst.example%2Fpage&amp;rut=1">First <b>Result</b></a>
      <div class="result__snippet">Snippet about budgets.</div>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsecond.example%2F">Second Result</a>
    `;
    const sources = parseDuckDuckGo(html);
    expect(sources.length).toBeGreaterThanOrEqual(1);
    expect(sources[0].url).toBe("https://first.example/page");
    expect(sources[0].title).toBe("First Result");
  });
});
