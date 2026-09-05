import { describe, expect, it } from "vitest";
import { cleanThinkingLine } from "@/providers/engine-chat";

/**
 * Tests for the thinking/reasoning display cleanup.
 * The engine emits agent-loop status with decorative emojis; the UI strips
 * them and drops pure-noise lines so the panel reads professionally.
 */
describe("cleanThinkingLine", () => {
  it("strips the gear emoji from agent step lines", () => {
    const result = cleanThinkingLine("⚙️ agent step 1...");
    expect(result).toBe("agent step 1...");
  });

  it("strips the tool emoji from tool call lines", () => {
    const result = cleanThinkingLine("🛠️ web_search({\"query\":\"hello\"})");
    expect(result).toContain("web_search");
    expect(result).not.toContain("🛠️");
  });

  it("converts the arrow from tool result lines", () => {
    const result = cleanThinkingLine("↳ web_search returned 1308 chars");
    expect(result).toBe("→ web_search returned 1308 chars");
  });

  it("drops pure spinner lines (⏳)", () => {
    expect(cleanThinkingLine("⏳")).toBeNull();
  });

  it("drops empty lines", () => {
    expect(cleanThinkingLine("")).toBeNull();
    expect(cleanThinkingLine("   ")).toBeNull();
  });

  it("passes through model reasoning text unchanged", () => {
    const reasoning = "Let me think about this problem carefully. First I need to...";
    expect(cleanThinkingLine(reasoning)).toBe(reasoning);
  });

  it("formats tool call arguments readably", () => {
    const result = cleanThinkingLine("🛠️ web_search({\"query\":\"latest AI news\"})");
    expect(result).toBe("web_search(query=latest AI news)");
  });

  it("handles multiple steps", () => {
    expect(cleanThinkingLine("⚙️ agent step 2...")).toBe("agent step 2...");
    expect(cleanThinkingLine("⚙️ agent step 10...")).toBe("agent step 10...");
  });

  it("does not mangle technical content", () => {
    const text = "Analyzing error: SyntaxError at line 3, column 14";
    expect(cleanThinkingLine(text)).toBe(text);
  });
});
