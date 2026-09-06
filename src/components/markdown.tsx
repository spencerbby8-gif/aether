"use client";

import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import { Icon } from "./icons";
import { copyText, toast } from "@/lib/utils";

interface NodeLike {
  children?: Array<NodeLike | string>;
  properties?: { className?: string[] };
  tagName?: string;
  value?: string;
}

function nodeText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  const record = node as NodeLike;
  if (typeof record.value === "string") return record.value;
  if (Array.isArray(record.children)) return record.children.map(nodeText).join("");
  return "";
}

function findCodeChild(node: unknown): NodeLike | null {
  const record = node as NodeLike;
  if (!record || typeof record !== "object") return null;
  if (record.tagName === "code") return record;
  for (const child of record.children ?? []) {
    const found = findCodeChild(child);
    if (found) return found;
  }
  return null;
}

function CodeCard(props: { children?: ReactNode; node?: unknown }) {
  const [copied, setCopied] = useState(false);
  const codeNode = findCodeChild(props.node);
  const className = codeNode?.properties?.className?.join(" ") ?? "";
  const language = /language-([\w-]+)/.exec(className)?.[1] ?? "text";
  const raw = nodeText(codeNode);

  const onCopy = async () => {
    if (await copyText(raw)) {
      setCopied(true);
      toast("Code copied", "ok");
      setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <div className="code-card">
      <div className="flex items-center justify-between border-b border-line bg-ink-850 px-3.5 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-fog-500">{language}</span>
        <button
          type="button"
          onClick={onCopy}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-fog-400 transition-colors hover:bg-ink-700 hover:text-fog-200"
        >
          <Icon name={copied ? "check" : "copy"} size={12.5} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{props.children}</pre>
    </div>
  );
}

type MDProps = { children?: ReactNode; className?: string; href?: string; node?: unknown };

/* Render image/audio/video URLs inline (from image/audio generation) rather
   than as plain links. Detection is by URL extension. */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)(\?|$)/i;
const AUDIO_EXT = /\.(wav|mp3|ogg|m4a)(\?|$)/i;
const VIDEO_EXT = /\.(mp4|webm|mov)(\?|$)/i;

/** Download button for generated media. */
function MediaDownload({ href, name }: { href: string; name: string }) {
  return (
    <a
      href={href}
      download={name}
      className="inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-ink-800 px-2.5 py-1 text-[11px] font-medium text-fog-300 transition-colors hover:bg-ink-700 hover:text-fog-100"
      title={`Download ${name}`}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
      </svg>
      Download
    </a>
  );
}

/*
 * Media wrappers use <span className="block"> rather than <div>.
 *
 * FIX (audit R5 / A7): react-markdown renders an image node inside the
 * surrounding <p>, and a <div> there is invalid HTML — the browser silently
 * closes the paragraph, so the server HTML and the hydrated tree disagree and
 * React 19 reports "In HTML, <div> cannot be a descendant of <p>. This will
 * cause a hydration error." A span with display:block is valid inside <p> and
 * renders identically.
 */
function renderInlineMedia(href: string, children: ReactNode): ReactNode {
  if (IMAGE_EXT.test(href)) {
    const fileName = href.split("/").pop() ?? "generated-image.jpg";
    return (
      <span className="my-2 block">
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="group/my-image relative block w-fit max-w-full"
          title="Click to view full resolution"
        >
          <img
            src={href}
            alt={typeof children === "string" ? children : "generated image"}
            className="block max-h-[70vh] w-auto max-w-full rounded-xl border border-line-strong object-contain shadow-lg shadow-black/30 transition-opacity group-hover/my-image:opacity-95"
            loading="eager"
            decoding="async"
          />
        </a>
        <span className="mt-1.5 flex items-center gap-2">
          <MediaDownload href={href} name={fileName} />
          <span className="text-[10.5px] text-fog-600">{fileName}</span>
        </span>
      </span>
    );
  }
  if (AUDIO_EXT.test(href)) {
    const fileName = href.split("/").pop() ?? "generated-audio.wav";
    return (
      <span className="my-2 block">
        <audio src={href} controls className="block h-10 w-full max-w-sm" />
        <span className="mt-1.5 block">
          <MediaDownload href={href} name={fileName} />
        </span>
      </span>
    );
  }
  if (VIDEO_EXT.test(href)) {
    const fileName = href.split("/").pop() ?? "generated-video.mp4";
    return (
      <span className="my-2 block">
        <video src={href} controls className="block max-h-80 max-w-full rounded-lg border border-line" />
        <span className="mt-1.5 block">
          <MediaDownload href={href} name={fileName} />
        </span>
      </span>
    );
  }
  return null;
}

const components = {
  pre: (props: MDProps) => <CodeCard node={props.node}>{props.children}</CodeCard>,
  code: (props: MDProps) => {
    const isBlock = typeof props.className === "string" && props.className.includes("hljs");
    if (isBlock) return <code className={props.className}>{props.children}</code>;
    return <code className="md-inline">{props.children}</code>;
  },
  table: (props: MDProps) => (
    <div className="table-scroll">
      <table>{props.children}</table>
    </div>
  ),
  a: (props: MDProps) => {
    if (props.href) {
      const media = renderInlineMedia(props.href, props.children);
      if (media) return <>{media}</>;
    }
    return (
      <a href={props.href} target="_blank" rel="noopener noreferrer">
        {props.children}
      </a>
    );
  },
  /* Markdown image nodes (from linkified generation URLs and ![alt](url))
     render at full resolution — the old max-h-80 (320px) crushed 1024px
     generated images to ~31% size, which read as blur. */
  img: (props: { src?: string; alt?: string }) => {
    const src = props.src ?? "";
    if (!src) return null;
    /* Only generated/remote media URLs get the premium treatment. */
    if (!/^https?:\/\//i.test(src)) {
      return <img src={src} alt={props.alt ?? ""} className="my-2 max-w-full rounded-lg" />;
    }
    const fileName = src.split("/").pop() ?? "generated-image";
    return (
      <span className="my-2 block">
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="group/my-image relative block w-fit max-w-full"
          title="Click to view full resolution"
        >
          <img
            src={src}
            alt={props.alt ?? "generated image"}
            className="block max-h-[70vh] w-auto max-w-full rounded-xl border border-line-strong object-contain shadow-lg shadow-black/30 transition-opacity group-hover/my-image:opacity-95"
            loading="eager"
            decoding="async"
          />
        </a>
        <span className="mt-1.5 flex items-center gap-2">
          <MediaDownload href={src} name={fileName} />
          <span className="text-[10.5px] text-fog-600">{fileName}</span>
        </span>
      </span>
    );
  },
} as unknown as Components;

/**
 * Convert bare media URLs (from image/audio generation) into Markdown
 * image/media syntax so they render inline regardless of autolink behavior.
 * Only touches standalone URLs on their own line ending in a media extension.
 */
export function linkifyMediaUrls(content: string): string {
  return content.replace(
    /(^|\n)(https?:\/\/[^\s<>"]+\.(?:png|jpe?g|webp|gif|avif|wav|mp3|ogg|m4a|mp4|webm|mov)(?:\?[^\s<>"]*)?)(?=\n|$)/gi,
    (_match, prefix: string, url: string) => {
      if (IMAGE_EXT.test(url)) return `${prefix}![generated image](${url})`;
      return `${prefix}${url}`;
    },
  );
}

/** Rich renderer for agent output: Markdown, GFM tables, code, JSON, LaTeX. */
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  const processed = linkifyMediaUrls(content);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }], rehypeKatex]}
        components={components}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
});
