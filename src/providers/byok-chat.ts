"use client";

import type { AgentEvent, ChatTurn } from "@/lib/types";
import type { ByokConnection } from "@/lib/byok";
import { controlAuthHeaders } from "@/lib/control-auth";
import { readNdjson } from "@/lib/engine-client";
import type { EngineChatOutcome } from "./engine-chat";

/** Run one selected personal provider. No key is written by the server. */
export async function runByokChat(options: {
  turns: ChatTurn[];
  connection: ByokConnection;
  model: string;
  instructions: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  streaming: boolean;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}): Promise<EngineChatOutcome> {
  const { turns, connection, model, instructions, temperature, maxTokens, timeoutMs, streaming, signal, onEvent } = options;
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = turns
    .filter((turn) => turn.role === "user" || turn.role === "assistant")
    .map((turn) => ({ role: turn.role as "user" | "assistant", content: turn.content }));
  if (instructions.trim()) messages.unshift({ role: "system", content: instructions.trim() });

  try {
    const response = await fetch("/api/byok/chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await controlAuthHeaders()) },
      body: JSON.stringify({
        connection: { provider: connection.provider, baseUrl: connection.baseUrl, apiKey: connection.apiKey },
        model,
        messages,
        temperature,
        maxTokens,
        timeoutMs,
        stream: streaming,
      }),
      signal,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      return { status: "error", text: "", error: body?.error ?? `Provider request failed (HTTP ${response.status}).`, attachments: [] };
    }

    let content = "";
    let failed: string | undefined;
    for await (const line of readNdjson(response, signal)) {
      if (signal.aborted) break;
      const message = line.message as { content?: string } | undefined;
      if (message?.content) {
        content += message.content;
        onEvent({ type: "delta", text: message.content });
      }
      const error = line.error as { message?: string } | undefined;
      if (error?.message) failed = error.message;
    }
    if (signal.aborted) return { status: "stopped", text: content, attachments: [] };
    if (failed) return { status: "error", text: content, error: failed, attachments: [] };
    if (!content) return { status: "error", text: "", error: "The provider completed without returning text.", attachments: [] };
    return { status: "complete", text: content, attachments: [] };
  } catch (error) {
    if (signal.aborted) return { status: "stopped", text: "", attachments: [] };
    return {
      status: "error",
      text: "",
      error: error instanceof Error ? error.message : "The provider connection failed.",
      attachments: [],
    };
  }
}
