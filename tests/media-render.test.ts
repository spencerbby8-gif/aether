// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import React from "react";
import { linkifyMediaUrls, Markdown } from "@/components/markdown";

describe("Markdown inline media rendering (DOM)", () => {
  it("renders a generated image URL as an inline <img>", () => {
    const content = "Here is the image:\n\nhttps://engine.trycloudflare.com/files/photo.jpg\n\nDone.";
    const { container } = render(React.createElement(Markdown, { content }));
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://engine.trycloudflare.com/files/photo.jpg");
  });

  it("renders a markdown image as an inline <img>", () => {
    const { container } = render(React.createElement(Markdown, { content: "![alt](https://x.com/img.png)" }));
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://x.com/img.png");
  });

  it("renders the real engine image URL shape as an inline <img>", () => {
    const content =
      "Here's your image! 🌲\n\nhttps://goals-coaching-abraham-com.trycloudflare.com/files/green_forest.jpg\n\nA lush forest.";
    const { container } = render(React.createElement(Markdown, { content }));
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toContain("green_forest.jpg");
  });

  it("does not turn a normal link into an image", () => {
    const { container } = render(React.createElement(Markdown, { content: "See https://example.com/page for details." }));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).not.toBeNull();
  });

  it("renders a generated audio URL as an <audio> player", () => {
    const content = "Listen:\n\nhttps://engine.trycloudflare.com/files/voice.wav\n\nEnjoy.";
    const { container } = render(React.createElement(Markdown, { content }));
    const audio = container.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute("src")).toContain("voice.wav");
  });

  it("renders a markdown audio link as an <audio> player", () => {
    const { container } = render(React.createElement(Markdown, { content: "[audio](https://x.com/voice.wav)" }));
    const audio = container.querySelector("audio");
    expect(audio).not.toBeNull();
  });

  it("renders a video URL as a <video> player", () => {
    const { container } = render(React.createElement(Markdown, { content: "[video](https://x.com/clip.mp4)" }));
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
  });
});

describe("linkifyMediaUrls — inline media from generation URLs", () => {
  it("converts a bare image URL on its own line to markdown image syntax", () => {
    const input = "Here is the image:\n\nhttps://engine.trycloudflare.com/files/photo.jpg\n\nDone.";
    const out = linkifyMediaUrls(input);
    expect(out).toContain("![generated image](https://engine.trycloudflare.com/files/photo.jpg)");
  });

  it("converts png/webp/jpeg extensions", () => {
    expect(linkifyMediaUrls("\nhttps://x.com/a.png\n")).toContain("![generated image](https://x.com/a.png)");
    expect(linkifyMediaUrls("\nhttps://x.com/a.webp\n")).toContain("![generated image](https://x.com/a.webp)");
    expect(linkifyMediaUrls("\nhttps://x.com/a.jpeg\n")).toContain("![generated image](https://x.com/a.jpeg)");
  });

  it("leaves audio/video URLs as plain URLs (rendered via link handler)", () => {
    const audio = linkifyMediaUrls("\nhttps://x.com/voice.wav\n");
    expect(audio).toContain("https://x.com/voice.wav");
    expect(audio).not.toContain("![generated image]");
    const video = linkifyMediaUrls("\nhttps://x.com/clip.mp4\n");
    expect(video).toContain("https://x.com/clip.mp4");
  });

  it("does not touch normal links or non-media URLs", () => {
    const input = "See https://example.com/page for details.";
    expect(linkifyMediaUrls(input)).toBe(input);
  });

  it("handles URLs with query strings", () => {
    const input = "\nhttps://x.com/files/img.jpg?token=abc\n";
    expect(linkifyMediaUrls(input)).toContain("![generated image](https://x.com/files/img.jpg?token=abc)");
  });

  it("handles the real engine image URL shape", () => {
    const input =
      "Here's your image! 🌲\n\nhttps://goals-coaching-abraham-com.trycloudflare.com/files/green_forest.jpg\n\nA lush forest.";
    const out = linkifyMediaUrls(input);
    expect(out).toContain("![generated image](https://goals-coaching-abraham-com.trycloudflare.com/files/green_forest.jpg)");
  });
});
