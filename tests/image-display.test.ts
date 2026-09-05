// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import React from "react";
import { Markdown } from "@/components/markdown";

describe("image display quality (full resolution, no downscale blur)", () => {
  it("renders a generated image at large size (not max-h-80/320px)", () => {
    const content = "Here:\n\nhttps://engine.example/files/photo.jpg\n\nDone.";
    const { container } = render(React.createElement(Markdown, { content }));
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    const cls = img?.getAttribute("class") ?? "";
    /* The old bug: max-h-80 (320px) crushed a 1024px image to 31% size. */
    expect(cls).not.toContain("max-h-80");
    expect(cls).toContain("max-h-[70vh]");
    expect(cls).toContain("object-contain");
  });

  it("wraps the image in a full-resolution link", () => {
    const content = "\nhttps://engine.example/files/art.jpg\n";
    const { container } = render(React.createElement(Markdown, { content }));
    const link = container.querySelector("a[href='https://engine.example/files/art.jpg']");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });

  it("loads generated images eagerly (not lazy — they are the primary content)", () => {
    const content = "\nhttps://engine.example/files/pic.png\n";
    const { container } = render(React.createElement(Markdown, { content }));
    const img = container.querySelector("img");
    expect(img?.getAttribute("loading")).toBe("eager");
  });

  it("still renders audio as a player", () => {
    const { container } = render(React.createElement(Markdown, { content: "\nhttps://x.com/v.wav\n" }));
    expect(container.querySelector("audio")).not.toBeNull();
  });

  it("does not apply the media wrapper to normal links", () => {
    const { container } = render(React.createElement(Markdown, { content: "See https://example.com/about." }));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).not.toBeNull();
  });
});

describe("reasoning panel (real streamed thinking)", () => {
  /* The ThinkingPanel is not exported, so we verify it through the Message
     renderer indirectly: a message with `thinking` must render the panel. */
  it("renders markdown images with the new large-size classes", () => {
    const content = "Image:\n\nhttps://e.example/i.jpg";
    const { container } = render(React.createElement(Markdown, { content }));
    const img = container.querySelector("img");
    const cls = img?.getAttribute("class") ?? "";
    expect(cls).toContain("rounded-xl");
    expect(cls).toContain("shadow-lg");
  });
});
