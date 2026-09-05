import { describe, expect, it } from "vitest";
import { WebProvider, parseDuckDuckGo, type FetchLikeResponse } from "@/server/tools/web";

function htmlResponse(body: string, status = 200): FetchLikeResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html" : null) },
    text: async () => body,
  };
}

const DDG_RESULT = `<html><body>
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnextjs.org%2Fdocs&amp;rut=1">Next.js Docs</a>
<div class="result__snippet">The React framework for the web.</div>
</body></html>`;

const LITE_RESULT = `<html><body>
<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnextjs.org%2F&amp;rut=1" class="result-link">Next.js</a>
<td class="result-snippet">Build web apps with React.</td>
</body></html>`;

describe("web search healing", () => {
  it("heals from a blocked primary endpoint to a working fallback", async () => {
    /* GET html returns a bot-challenge (202, no results); POST html works. */
    let postCalls = 0;
    const fetchImpl = (async () => htmlResponse("<html>202 challenge</html>", 200)) as never;
    const searchFetch = (async (url: string) => {
      postCalls += 1;
      return htmlResponse(DDG_RESULT);
    }) as never;
    const provider = new WebProvider(fetchImpl, searchFetch);
    const result = await provider.webSearch({ query: "nextjs" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Next.js Docs");
    expect(postCalls).toBeGreaterThan(0); // the healing fallback actually ran
  });

  it("never fabricates results — honest degradation when every strategy is blocked", async () => {
    const fetchImpl = (async () => htmlResponse("<html>challenge page, no results</html>", 200)) as never;
    const searchFetch = (async () => htmlResponse("<html>challenge page</html>", 200)) as never;
    const provider = new WebProvider(fetchImpl, searchFetch);
    const result = await provider.webSearch({ query: "anything" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("unavailable");
    expect(result.text).not.toContain("http"); // no fake URLs invented
  });

  it("parses the full html layout with uddg unwrapping", () => {
    const sources = parseDuckDuckGo(DDG_RESULT);
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("https://nextjs.org/docs");
    expect(sources[0].title).toBe("Next.js Docs");
    expect(sources[0].snippet).toContain("React framework");
  });

  it("parses the lite layout", () => {
    const sources = parseDuckDuckGo(LITE_RESULT);
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("https://nextjs.org/");
    expect(sources[0].title).toBe("Next.js");
    expect(sources[0].snippet).toContain("React");
  });
});

describe("web fetch healing (transient retry)", () => {
  it("retries once on 503 and succeeds on the second attempt", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return htmlResponse("service unavailable", 503);
      return htmlResponse("<html><title>Recovered</title><body>ok content</body></html>", 200);
    }) as never;
    const provider = new WebProvider(fetchImpl);
    const result = await provider.webFetch({ url: "https://example.com" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Recovered");
    expect(calls).toBe(2); // proves the healing retry fired
  });

  it("does not retry deterministic 4xx failures", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return htmlResponse("not found", 404);
    }) as never;
    const provider = new WebProvider(fetchImpl);
    const result = await provider.webFetch({ url: "https://example.com/missing" });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1); // no pointless retry on 404
  });
});
