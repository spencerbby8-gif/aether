"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AttachmentMeta } from "@/lib/types";
import { cn, formatBytes } from "@/lib/utils";
import { FileStore } from "@/storage";
import { MediaProvider } from "@/providers";
import type { SlashResult } from "@/hooks/useAether";
import { Icon } from "./icons";

export interface ComposerHandle {
  addFiles: (files: File[]) => Promise<void>;
  focus: () => void;
}

interface SlashCommand {
  name: string;
  hint: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "task", hint: "<goal>", description: "Run a multi-step agent task" },
  { name: "new", hint: "", description: "Start a fresh conversation" },
  { name: "clear", hint: "", description: "Clear messages in this conversation" },
  { name: "title", hint: "<name>", description: "Rename this conversation" },
  { name: "export", hint: "", description: "Export the workspace as JSON" },
];

interface ComposerProps {
  busy: boolean;
  disabled?: boolean;
  onSend: (text: string, attachments: AttachmentMeta[]) => void;
  onStop: () => void;
  onCommand: (name: string, arg: string) => Promise<SlashResult>;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { busy, disabled, onSend, onStop, onCommand },
  ref,
) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [attaching, setAttaching] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* autosize */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 208)}px`;
  }, [value]);

  const slashActive = useMemo(() => {
    if (!value.startsWith("/") || value.includes("\n")) return false;
    const head = value.split(" ")[0];
    return head.length <= 9;
  }, [value]);

  const slashMatches = useMemo(() => {
    if (!slashActive) return [];
    const head = value.split(" ")[0].slice(1).toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(head));
  }, [slashActive, value]);

  useEffect(() => {
    setSlashIndex(0);
  }, [slashMatches.length]);

  const attach = async (files: File[]) => {
    if (files.length === 0) return;
    setAttaching(true);
    try {
      const metas = await MediaProvider.fromFiles(files);
      if (metas.length > 0) setAttachments((prev) => [...prev, ...metas]);
    } finally {
      setAttaching(false);
    }
  };

  useImperativeHandle(ref, () => ({
    addFiles: async (files: File[]) => {
      await attach(files);
      textareaRef.current?.focus();
    },
    focus: () => textareaRef.current?.focus(),
  }));

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const submit = () => {
    if (busy || disabled) return;
    const text = value.trim();
    if (!text && attachments.length === 0) return;
    onSend(text, attachments);
    setValue("");
    setAttachments([]);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const runSlash = async (raw: string) => {
    const body = raw.slice(1);
    const [name = "", ...rest] = body.split(/\s+/);
    const arg = rest.join(" ");
    const result = await onCommand(name.toLowerCase(), arg);
    if (result.handled) {
      setValue("");
      setAttachments([]);
    } else if (result.insert !== undefined) {
      setValue(result.insert);
    }
    textareaRef.current?.focus();
  };

  const knownCommand = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("/") || trimmed.length < 2) return null;
    const name = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase() ?? "";
    return SLASH_COMMANDS.find((c) => c.name === name) ?? null;
  };

  const onKeyDown = async (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashActive && slashMatches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const command = slashMatches[slashIndex];
        setValue(command.hint ? `/${command.name} ` : `/${command.name}`);
        return;
      }
      if (event.key === "Escape") {
        setValue("");
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const command = slashMatches[slashIndex];
        const hasArg = value.trim().length > command.name.length + 1;
        if ((command.name === "title" || command.name === "task") && !hasArg) {
          setValue(`/${command.name} `);
        } else if (command.name === "task") {
          /* /task rides through submit() so attachments reach the task. */
          submit();
        } else {
          await runSlash(value);
        }
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      /* Known slash commands execute; anything else is sent as a message. */
      if (knownCommand(value)) {
        const name = value.trim().slice(1).split(/\s+/)[0]?.toLowerCase();
        if (name === "task" && value.trim().length > 6) submit();
        else await runSlash(value.trim());
        return;
      }
      submit();
    }
  };

  const onPaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const metas = await MediaProvider.fromClipboard(event.clipboardData);
    if (metas.length > 0) {
      event.preventDefault();
      setAttachments((prev) => [...prev, ...metas]);
    }
  };

  const canSend = !busy && !disabled && (value.trim().length > 0 || attachments.length > 0);

  return (
    <div className="relative border-t border-line bg-ink-900 px-3 pb-[calc(10px+env(safe-area-inset-bottom))] pt-3 sm:px-5">
      {/* slash menu */}
      {slashActive && slashMatches.length > 0 ? (
        <div className="anim-pop absolute bottom-full left-3 z-30 mb-2 w-72 overflow-hidden rounded-xl border border-line-strong bg-ink-800 shadow-2xl shadow-black/50 sm:left-5">
          <div className="border-b border-line px-3.5 py-2 text-[10.5px] font-semibold uppercase tracking-wider text-fog-600">
            Commands
          </div>
          {slashMatches.map((command, index) => (
            <button
              key={command.name}
              type="button"
              onMouseEnter={() => setSlashIndex(index)}
              onClick={() => {
                if (command.hint) setValue(`/${command.name} `);
                else void runSlash(`/${command.name}`);
              }}
              className={cn(
                "flex w-full items-baseline gap-2.5 px-3.5 py-2.5 text-left transition-colors",
                index === slashIndex ? "bg-ink-700" : "",
              )}
            >
              <span className="font-mono text-[12.5px] text-ember-300">
                /{command.name}
                {command.hint ? <span className="text-fog-600"> {command.hint}</span> : null}
              </span>
              <span className="ml-auto truncate text-[11.5px] text-fog-500">{command.description}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="mx-auto w-full max-w-3xl">
        {/* attachment previews */}
        {attachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <AttachmentChip key={attachment.id} attachment={attachment} onRemove={() => removeAttachment(attachment.id)} />
            ))}
          </div>
        ) : null}

        <div
          className={cn(
            "composer-frame flex items-end gap-1.5 rounded-2xl border border-line-strong bg-ink-800 p-2 shadow-lg shadow-black/25",
            disabled && "opacity-60",
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              void attach(files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || disabled || attaching}
            className="mb-0.5 shrink-0 rounded-xl p-2 text-fog-500 transition-colors hover:bg-ink-700 hover:text-fog-200 disabled:pointer-events-none disabled:opacity-50"
            aria-label="Attach files"
            title="Attach files"
          >
            <Icon name="paperclip" size={17} />
          </button>

          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => void onKeyDown(event)}
            onPaste={(event) => void onPaste(event)}
            rows={1}
            disabled={disabled}
            placeholder={busy ? "Aether is responding…" : "Message Aether — / for commands"}
            className="max-h-52 min-h-[38px] flex-1 resize-none bg-transparent py-2 text-[14px] leading-relaxed text-fog-100 placeholder:text-fog-600 focus:outline-none disabled:cursor-not-allowed"
          />

          {busy ? (
            <button
              type="button"
              onClick={onStop}
              className="mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border border-danger-400/35 bg-danger-400/10 text-danger-400 transition-colors hover:bg-danger-400/20"
              aria-label="Stop generating"
              title="Stop generating"
            >
              <Icon name="stop" size={15} />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              className={cn(
                "mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl transition-all",
                canSend
                  ? "bg-ember-400 text-ink-950 shadow-[0_4px_16px_-4px_rgba(226,177,97,0.6)] hover:bg-ember-300 active:scale-95"
                  : "bg-ink-700 text-fog-600",
              )}
              aria-label="Send message"
              title="Send"
            >
              <Icon name="send" size={16} strokeWidth={2.2} />
            </button>
          )}
        </div>

        <div className="mx-auto mt-2 flex items-center justify-center text-[11px] text-fog-600">
          {attaching ? (
            <span>Storing attachment…</span>
          ) : (
            <span className="flex flex-wrap items-center justify-center gap-x-1.5 whitespace-nowrap">
              <span className="hidden sm:inline">
                <kbd className="rounded border border-line bg-ink-850 px-1 py-px font-mono text-[10px]">Enter</kbd> send ·{" "}
                <kbd className="rounded border border-line bg-ink-850 px-1 py-px font-mono text-[10px]">Shift+Enter</kbd> newline · paste or drop media
              </span>
              <span className="sm:hidden">Enter to send · Shift+Enter for newline</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

function AttachmentChip({ attachment, onRemove }: { attachment: AttachmentMeta; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    FileStore.urlFor(attachment.id).then((resolved) => {
      if (!cancelled) setUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [attachment.id]);

  const chipIcon =
    attachment.kind === "video" ? "play" : attachment.kind === "audio" ? "sparkle" : "file";

  return (
    <div className="anim-pop group relative">
      {attachment.kind === "image" && url ? (
        <img src={url} alt={attachment.name} className="h-14 w-14 rounded-lg border border-line-strong object-cover" />
      ) : (
        <span className="flex h-14 items-center gap-2 rounded-lg border border-line-strong bg-ink-800 px-3">
          <Icon name={chipIcon} size={14} className="text-fog-500" />
          <span className="max-w-36 truncate text-[12px] text-fog-300">{attachment.name}</span>
          <span className="text-[10.5px] text-fog-600">{formatBytes(attachment.size)}</span>
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-line-strong bg-ink-700 text-fog-300 shadow transition-colors hover:bg-danger-400 hover:text-ink-950"
        aria-label={`Remove ${attachment.name}`}
      >
        <Icon name="x" size={10} strokeWidth={2.4} />
      </button>
    </div>
  );
}
