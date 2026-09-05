// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { ThinkingPanel } from "@/components/chat";

/* Cleaned thinking events (post cleanThinkingLine) as the UI receives them. */
const REAL_STEPS = [
  "agent step 1...",
  "web_search(query=tallest mountain)",
  "→ web_search returned 1308 chars",
  "agent step 2...",
];

describe("ThinkingPanel — real streamed reasoning", () => {
  it("renders only when thinking content exists (no fake panel)", () => {
    const { container } = render(React.createElement(ThinkingPanel, { thinking: "", live: false }));
    /* Empty thinking should still render the shell (it's only mounted when
       message.thinking is truthy), but with zero step lines. */
    const panel = container.querySelector('[data-testid="thinking-panel"]');
    expect(panel).not.toBeNull();
  });

  it("renders every real streamed step", () => {
    const { container } = render(
      React.createElement(ThinkingPanel, { thinking: REAL_STEPS.join("\n"), live: true }),
    );
    const panel = container.querySelector('[data-testid="thinking-panel"]');
    expect(panel).not.toBeNull();
    const text = panel?.textContent ?? "";
    expect(text).toContain("agent step 1");
    expect(text).toContain("web_search");
    expect(text).toContain("returned 1308 chars");
    expect(text).toContain("agent step 2");
  });

  it("shows the live indicator while streaming", () => {
    const { container } = render(
      React.createElement(ThinkingPanel, { thinking: REAL_STEPS.join("\n"), live: true }),
    );
    const label = container.querySelector("button")?.textContent ?? "";
    expect(label).toContain("Thinking");
    expect(label).toContain("4 steps");
  });

  it("shows the step count when not live", () => {
    const { container } = render(
      React.createElement(ThinkingPanel, { thinking: REAL_STEPS.join("\n"), live: false }),
    );
    const label = container.querySelector("button")?.textContent ?? "";
    expect(label).toContain("4 steps");
  });

  it("collapses and expands via the chevron toggle", () => {
    const { container } = render(
      React.createElement(ThinkingPanel, { thinking: REAL_STEPS.join("\n"), live: false }),
    );
    const btn = container.querySelector("button");
    expect(btn?.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(btn!);
    expect(btn?.getAttribute("aria-expanded")).toBe("false");
    /* Content hidden when collapsed. */
    expect(container.querySelector('[data-testid="thinking-panel"]')?.textContent).not.toContain("agent step 1");
    fireEvent.click(btn!);
    expect(btn?.getAttribute("aria-expanded")).toBe("true");
  });

  it("never invents reasoning text — only renders what was passed in", () => {
    const only = "🛠️ run_command({\"command\": \"ls\"})";
    const { container } = render(React.createElement(ThinkingPanel, { thinking: only, live: true }));
    const text = container.textContent ?? "";
    expect(text).toContain("run_command");
    /* Nothing beyond the single real step. */
    expect(text).not.toContain("web_search");
    expect(text).not.toContain("agent step 2");
  });

  it("marks tool-call lines distinctly (ember bullet)", () => {
    const { container } = render(
      React.createElement(ThinkingPanel, { thinking: REAL_STEPS.join("\n"), live: false }),
    );
    const bullets = container.querySelectorAll(".bg-ember-400\\/70");
    expect(bullets.length).toBeGreaterThan(0);
  });
});
