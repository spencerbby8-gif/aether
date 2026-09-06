import { describe, expect, it } from "vitest";
import { interpretBeacon, parseNtfyLines, parseWebhookRequests } from "@/server/engine/beacon";

describe("beacon parsing (real wire formats)", () => {
  it("parses webhook.site heartbeats carried as ?m= query params", () => {
    const events = parseWebhookRequests({
      data: [
        { url: "https://webhook.site/00000000-0000-4000-8000-000000000000?m=stage%3A+starting+gpus%3D1", created_at: "2026-08-31T21:10:00Z" },
        {
          url: "https://webhook.site/00000000-0000-4000-8000-000000000000?m=AGENT+LIVE+LINK%3A+https%3A%2F%2Fadd-awarded-tablet-uncle.trycloudflare.com+(tools%3A+web_search)",
          created_at: "2026-08-31T21:12:00Z",
        },
        { url: "https://webhook.site/00000000-0000-4000-8000-000000000000?m=alive%3A+https%3A%2F%2Fadd-awarded-tablet-uncle.trycloudflare.com+(idle+0+min)", created_at: "2026-08-31T21:13:00Z" },
      ],
    });
    expect(events).toHaveLength(3);
    const signal = interpretBeacon(events);
    expect(signal.liveUrl).toBe("https://add-awarded-tablet-uncle.trycloudflare.com");
    expect(signal.off).toBe(false);
  });

  it("parses ntfy JSON lines and detects shutdown events", () => {
    const events = parseNtfyLines(
      [
        JSON.stringify({ time: 1000, message: "AGENT LIVE LINK: https://one.trycloudflare.com" }),
        JSON.stringify({ time: 1100, message: "alive: https://one.trycloudflare.com (idle 5 min)" }),
        JSON.stringify({ time: 1200, message: "ENGINE OFF via UI - quota saved" }),
        "not json",
      ].join("\n"),
    );
    const signal = interpretBeacon(events);
    expect(signal.off).toBe(true);
    expect(signal.liveUrl).toBe("https://one.trycloudflare.com");
  });

  it("treats the newest lifecycle event as authoritative (rotating URLs)", () => {
    const signal = interpretBeacon([
      { at: 1, text: "alive: https://old.trycloudflare.com (idle 0 min)" },
      { at: 2, text: "ENGINE OFF via UI - quota saved" },
      { at: 3, text: "AGENT LIVE LINK: https://new.trycloudflare.com (tools: web_search fetch_page crawl_site run_command)" },
    ]);
    expect(signal.off).toBe(false);
    expect(signal.liveUrl).toBe("https://new.trycloudflare.com");
  });
});
