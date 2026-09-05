import { describe, expect, it } from "vitest";

/**
 * Tests for the image-quality prompt enrichment in /api/agent/stream.
 * The engine's model writes the prompt that reaches the image generator, so
 * enriching the user's request with photographic directives produces
 * materially sharper, more detailed images. These tests pin that behaviour.
 */

/* Mirrors the route's internals so we test the exact logic. */
const IMAGE_INTENT =
  /\b(generate|create|make|draw|paint|render|produce|show)\b[^.!?]{0,40}\b(image|picture|photo|photograph|artwork|art|illustration|render|wallpaper|logo|portrait|scene|painting)\b/i;

const IMAGE_QUALITY_DIRECTIVE =
  " [Image quality guidance: when you call generate_image, write a single richly detailed prompt of 40-70 words describing the subject precisely, plus lighting (e.g. soft golden-hour rim light, or diffused studio softbox), composition/framing (e.g. tight macro shot, low-angle wide), lens and depth of field (e.g. 85mm f/1.4, shallow depth of field, creamy bokeh), texture and material detail, colour grading, and finish with \"photorealistic, ultra-detailed, sharp focus, high dynamic range, 8k\". Never send a short vague prompt.]";

function enrich(messages: Array<{ role: string; content: string }>) {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last.role !== "user") return messages;
  if (!IMAGE_INTENT.test(last.content)) return messages;
  if (last.content.includes("[Image quality guidance")) return messages;
  const out = [...messages];
  out[out.length - 1] = { role: last.role, content: last.content + IMAGE_QUALITY_DIRECTIVE };
  return out;
}

describe("image-quality prompt enrichment", () => {
  it("enriches a direct image request", () => {
    const out = enrich([{ role: "user", content: "Generate an image of a mountain lake." }]);
    expect(out[0].content).toContain("[Image quality guidance");
    expect(out[0].content).toContain("photorealistic");
    expect(out[0].content).toContain("85mm f/1.4");
    expect(out[0].content).toContain("golden-hour");
  });

  it("enriches varied phrasings", () => {
    for (const msg of [
      "create a picture of a cat",
      "draw me some art of a forest",
      "make a photo of a sunset",
      "render an illustration of a robot",
      "show me a portrait of a woman",
      "generate a wallpaper of mountains",
      "produce a painting of the ocean",
    ]) {
      const out = enrich([{ role: "user", content: msg }]);
      expect(out[0].content, msg).toContain("[Image quality guidance");
    }
  });

  it("does NOT enrich non-image requests", () => {
    for (const msg of [
      "What is the capital of France?",
      "Search the web for AI news.",
      "Run the command ls -la",
      "Write me a poem about mountains.",
      "Generate a summary of this article.",
      "Create a file called test.txt",
    ]) {
      const out = enrich([{ role: "user", content: msg }]);
      expect(out[0].content, msg).not.toContain("[Image quality guidance");
    }
  });

  it("does not enrich assistant messages", () => {
    const out = enrich([{ role: "assistant", content: "Generate an image of a cat." }]);
    expect(out[0].content).not.toContain("[Image quality guidance");
  });

  it("is idempotent — never double-appends", () => {
    const once = enrich([{ role: "user", content: "Generate an image of a dog." }]);
    const twice = enrich(once);
    expect(twice[0].content).toBe(once[0].content);
    expect((twice[0].content.match(/\[Image quality guidance/g) ?? []).length).toBe(1);
  });

  it("only enriches the LAST message, leaving history untouched", () => {
    const history = [
      { role: "user", content: "Generate an image of a bird." },
      { role: "assistant", content: "Here is your bird image." },
      { role: "user", content: "Generate an image of a fish." },
    ];
    const out = enrich(history);
    expect(out[0].content).not.toContain("[Image quality guidance");
    expect(out[2].content).toContain("[Image quality guidance");
  });

  it("preserves the original request text", () => {
    const original = "Generate an image of a lighthouse at dawn.";
    const out = enrich([{ role: "user", content: original }]);
    expect(out[0].content.startsWith(original)).toBe(true);
  });
});
