// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "react";
import { Markdown } from "@/components/markdown";

/**
 * Audit R5 / A7 — `<div>` inside `<p>` produced a React hydration error on every
 * generated image.
 *
 * Reproduced two ways, because they fail for different reasons:
 *   1. DOM validity of the server-rendered HTML (what the browser parses)
 *   2. the real hydrateRoot() console output (what React 19 actually reports)
 */

const CONTENT = [
  "Here is the result:",
  "",
  "https://engine.example/files/photo.jpg",
  "",
  "And an explicit image:",
  "",
  "![a generated image](https://engine.example/files/second.png)",
  "",
  "Done.",
].join("\n");

function serverHtml() {
  return renderToStaticMarkup(React.createElement(Markdown, { content: CONTENT }));
}

/** True when a block element is nested inside a <p> anywhere in the HTML. */
function blockInsideParagraph(html: string): string[] {
  const dom = new DOMParser().parseFromString(html, "text/html");
  const bad: string[] = [];
  for (const p of [...dom.querySelectorAll("p")]) {
    for (const el of [...p.querySelectorAll("div, section, figure, ul, ol, table, h1, h2, h3")]) {
      bad.push(`<${el.tagName.toLowerCase()}> inside <p>`);
    }
  }
  return bad;
}

describe("Markdown hydration (audit R5 / A7)", () => {
  let errors: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errors = [];
    spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    });
  });
  afterEach(() => {
    spy.mockRestore();
    document.body.innerHTML = "";
  });

  it("never nests a block element inside a paragraph", () => {
    const html = serverHtml();
    const offenders = blockInsideParagraph(html);
    expect(offenders).toEqual([]);
  });

  it("hydrates with no React DOM-nesting or hydration error", async () => {
    const html = serverHtml();
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.appendChild(host);

    await act(async () => {
      hydrateRoot(host, React.createElement(Markdown, { content: CONTENT }));
    });

    const relevant = errors.filter(
      (e) =>
        /hydrat/i.test(e) ||
        /cannot be a descendant of/i.test(e) ||
        /validateDOMNesting/i.test(e) ||
        /did not match/i.test(e),
    );
    expect(relevant).toEqual([]);
  });

  it("still renders the image at full resolution after the fix", () => {
    const html = serverHtml();
    const dom = new DOMParser().parseFromString(html, "text/html");
    const img = dom.querySelector("img");
    expect(img).not.toBeNull();
    /* The earlier blur bug: max-h-80 crushed 1024px images to ~31%. */
    expect(img?.getAttribute("class")).toContain("max-h-[70vh]");
    expect(img?.getAttribute("class")).not.toContain("max-h-80");
  });
});
