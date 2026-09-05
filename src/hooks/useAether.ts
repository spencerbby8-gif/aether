"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentRuntime } from "@/agent/runtime";
import { assembleContext, digestText, maybeRollSummary } from "@/agent/context";
import { mockAgentModel, resolveAgentModel } from "@/agent/model";
import { createDefaultRegistry, createFullRegistry, type ToolRegistry } from "@/agent/tools";
import { mediaEngine } from "@/media/engine";
import type {
  AgentEvent,
  AttachmentMeta,
  ChatTurn,
  Conversation,
  Message,
  Project,
  RuntimePhase,
  RuntimeSnapshot,
  RuntimeTask,
  Settings,
  ToolEventRecord,
} from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/types";
import { isModKey } from "@/lib/hooks";
import { toast, truncate, uid } from "@/lib/utils";
import { runEngineChat } from "@/providers/engine-chat";
import {
  ConversationStore,
  FileStore,
  ProjectStore,
  SettingsStore,
  TaskStore,
  exportWorkspace,
  wipeWorkspace,
} from "@/storage";

export type View = "chat" | "workspace";

/**
 * Chat request state machine (replaces ad-hoc loading flags).
 *
 *   idle ──▶ connecting ──▶ streaming ──▶ completed
 *                │             │    ▲
 *                │             ▼    └── tool ◀─┘
 *                │             tool
 *                ├──▶ aborted ◀────── (user Stop at any point)
 *                └──▶ error
 *
 * A request ALWAYS reaches a terminal state (completed / error / aborted),
 * enforced by a finally block — even on malformed events, network failure,
 * engine disconnect, timeout, or abort. This is what prevents the "stuck on
 * Thinking" bug where streamingIdRef stayed set and blocked all new messages.
 */
export type RequestState = "idle" | "connecting" | "streaming" | "tool" | "completed" | "error" | "aborted";

/** Back-compat alias for the runtime task phases (agent tasks). */
export type AgentPhase =
  | "idle"
  | "thinking"
  | "responding"
  | "planning"
  | "executing"
  | "waiting"
  | "paused"
  | "validating";

/** Derive the UI-visible phase from a persisted task. */
function phaseOf(task: RuntimeTask): RuntimePhase {
  switch (task.status) {
    case "pending":
    case "planning":
      return "planning";
    case "running":
      return "executing";
    case "waiting_approval":
      return "waiting";
    case "paused":
      return "paused";
    case "validating":
      return "validating";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "interrupted";
  }
}

/** Safe, user-facing snapshot of runtime progress for a message. */
function snapshotOf(task: RuntimeTask): RuntimeSnapshot {
  return {
    taskId: task.id,
    phase: phaseOf(task),
    steps: task.steps.map((s) => ({ id: s.id, title: s.title, state: s.state, attempts: s.attempts, tool: s.tool })),
    approval: task.approvals.find((a) => a.status === "pending"),
    notes: task.events.slice(-3).map((e) => e.text),
    output: task.output,
  };
}

export interface SlashResult {
  handled: boolean;
  insert?: string;
}

export function useAether(online: boolean) {
  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<View>("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>("idle");
  const [requestState, setRequestState] = useState<RequestState>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const [statsVersion, setStatsVersion] = useState(0);
  const [tasks, setTasks] = useState<RuntimeTask[]>([]);
  const [liveTask, setLiveTask] = useState<RuntimeTask | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const streamingIdRef = useRef<string | null>(null);
  const runtimeRef = useRef<AgentRuntime | null>(null);
  const taskBufferRef = useRef("");
  const registryRef = useRef<ToolRegistry | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const projectFilterRef = useRef<string | null>(null);
  const settingsRef = useRef(settings);
  const onlineRef = useRef(online);
  const lastPersistRef = useRef(0);

  useEffect(() => {
    settingsRef.current = settings;
    document.documentElement.dataset.motion = settings.reduceMotion ? "reduced" : "full";
  }, [settings]);
  useEffect(() => {
    onlineRef.current = online;
  }, [online]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  useEffect(() => {
    projectFilterRef.current = projectFilter;
  }, [projectFilter]);

  /* ---------------- boot ---------------- */

  const boot = useCallback(async () => {
    try {
      const [loadedSettings, loadedProjects, loadedConversations] = await Promise.all([
        SettingsStore.get(),
        ProjectStore.list(),
        ConversationStore.list(),
      ]);
      /* Recovery: anything left in flight by a previous session becomes resumable. */
      await TaskStore.markInterrupted();
      const loadedTasks = await TaskStore.list();
      setSettings(loadedSettings);
      setProjects(loadedProjects);
      setConversations(loadedConversations);
      setTasks(loadedTasks);
      setBootError(null);
      /* Phase 3: pull the server's real-tool capability manifest. Falls
         back to local-only tools automatically when offline. */
      void createFullRegistry().then(({ registry }) => {
        registryRef.current = registry;
      });
    } catch (error) {
      setBootError(error instanceof Error ? error.message : "The local workspace could not be opened.");
    } finally {
      setBooted(true);
    }
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  /* ---------------- conversation loading ---------------- */

  const loadMessages = useCallback(async (conversationId: string) => {
    setMessagesLoading(true);
    try {
      const loaded = await ConversationStore.messagesOf(conversationId);
      setMessages(loaded);
    } catch {
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  /* ---------------- agent pipeline ---------------- */

  const patchStreamingMessage = useCallback((messageId: string, patch: Partial<Message>) => {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, ...patch } : m)));
  }, []);

  const runAgent = useCallback(
    async (conversationId: string, prompt: string) => {
      /* ContextManager: recent window + summary + memory + project context,
         instead of replaying the entire conversation. */
      const conversation = await ConversationStore.get(conversationId);
      let turns: ChatTurn[] = [];
      try {
        const pack = await assembleContext({
          conversationId,
          projectId: conversation?.projectId ?? null,
          goal: prompt,
        });
        const digest = digestText(pack);
        if (digest) turns.push({ role: "user", content: `[workspace context]\n${digest}` });
        turns.push(...pack.recent);
      } catch {
        const history = await ConversationStore.messagesOf(conversationId);
        turns = history
          .filter((m) => (m.role === "user" && m.content.trim() !== "") || m.status === "complete")
          .map((m) => ({ role: m.role, content: m.content }));
      }
      if (!turns.some((t) => t.role === "user" && t.content === prompt)) {
        turns.push({ role: "user", content: prompt });
      }

      const assistantId = uid();
      streamingIdRef.current = assistantId;
      const assistant: Message = {
        id: assistantId,
        conversationId,
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: Date.now() + 1,
        updatedAt: Date.now() + 1,
        events: [],
      };
      setMessages((prev) => [...prev, assistant]);
      setAgentPhase("thinking");
      setLastError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      const events: ToolEventRecord[] = [];
      let sawDelta = false;
      let buffer = "";
      let thinkingBuffer = "";
      let statusText: string | undefined;
      const streaming = settingsRef.current.streaming;

      /* Batched flush: fast streams emit many deltas per frame; coalesce them
         into one re-render per frame (smooth, non-blocking, deduplicated).
         Falls back to a microtask when requestAnimationFrame is unavailable
         or paused (backgrounded tab) so content NEVER freezes. */
      let flushScheduled = false;
      let latestEvents = events;
      const doFlush = () => {
        flushScheduled = false;
        patchStreamingMessage(assistantId, {
          content: buffer,
          thinking: thinkingBuffer || undefined,
          statusText,
          events: [...latestEvents],
        });
      };
      const scheduleFlush = () => {
        if (flushScheduled) return;
        flushScheduled = true;
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => doFlush());
          /* Safety net: if RAF is paused (hidden tab), flush on a timer. */
          setTimeout(() => {
            if (flushScheduled) doFlush();
          }, 120);
        } else {
          setTimeout(doFlush, 16);
        }
      };

      const onEvent = (event: AgentEvent) => {
        if (event.type === "delta") {
          buffer += event.text;
          if (!sawDelta) {
            sawDelta = true;
            setRequestState("streaming");
          }
          if (streaming) scheduleFlush();
        } else if (event.type === "thinking") {
          thinkingBuffer = event.text;
          scheduleFlush();
        } else if (event.type === "status") {
          statusText = event.text;
          scheduleFlush();
        } else if (event.type === "tool") {
          setRequestState("tool");
          const index = events.findIndex((e) => e.id === event.id);
          const record: ToolEventRecord = { id: event.id, name: event.name, state: event.state, detail: event.detail };
          if (index >= 0) events[index] = record;
          else events.push(record);
          latestEvents = events;
          scheduleFlush();
        }
      };

      /* Real chat only: the engine fleet speaks NDJSON through our server.
         No fake/demo chat path exists — an unavailable engine is reported
         honestly with its lifecycle state, and Retry re-runs the request. */
      let outcome: {
        status: "complete" | "stopped" | "error";
        text: string;
        model?: string;
        error?: string;
        attachments?: AttachmentMeta[];
        thinking?: string;
      } = { status: "error", text: "", error: "The request did not complete." };
      setRequestState("connecting");
      try {
        if (!onlineRef.current) {
          outcome = {
            status: "error",
            text: "",
            error: "Offline — the engine fleet cannot be reached. Reconnect and retry.",
          };
        } else {
          const result = await runEngineChat({
            turns,
            signal: controller.signal,
            streaming,
            mode: settingsRef.current.provider,
            onEvent,
          });
          outcome = {
            status: result.status,
            text: result.text,
            model: "Qwen3.8-27B-Uncensored (IQ4_XS)",
            error: result.error,
            attachments: result.attachments,
            thinking: result.thinking,
          };
        }
      } catch (error) {
        /* Any unexpected failure still lands in a terminal state. */
        outcome = {
          status: controller.signal.aborted ? "stopped" : "error",
          text: buffer,
          error: controller.signal.aborted ? undefined : (error as Error)?.message ?? "The request failed.",
          thinking: thinkingBuffer || undefined,
        };
      } finally {
        /* GUARANTEED terminal transition. This is the fix for the stuck
           "Thinking" bug: streamingIdRef/abortRef are always cleared and the
           state machine always leaves the streaming states, so the next
           message can always start a fresh request. */
        abortRef.current = null;
        streamingIdRef.current = null;
        setRequestState(outcome.status === "complete" ? "completed" : outcome.status === "stopped" ? "aborted" : "error");
        setAgentPhase("idle");
      }

      /* Stopped before any text arrived → drop the empty stub entirely. */
      if (outcome.status === "stopped" && outcome.text.trim() === "") {
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        return;
      }

      const status = outcome.status === "error" ? "error" : outcome.status;
      const outcomeAttachments = (outcome as { attachments?: AttachmentMeta[] }).attachments;
      const outcomeThinking = (outcome as { thinking?: string }).thinking ?? thinkingBuffer;
      const finalMessage: Message = {
        ...assistant,
        content: outcome.text,
        status,
        error: outcome.error,
        model: outcome.model,
        events,
        thinking: outcomeThinking || undefined,
        statusText: undefined,
        attachments: outcomeAttachments && outcomeAttachments.length > 0 ? outcomeAttachments : undefined,
        updatedAt: Date.now(),
      };
      patchStreamingMessage(assistantId, finalMessage);
      /* Only then flip the phase — the UI must never show Ready before the
         final message is actually on screen. */
      setAgentPhase("idle");

      try {
        await ConversationStore.saveMessage(finalMessage);
        await ConversationStore.touch(conversationId);
        setConversations(await ConversationStore.list());
        setStatsVersion((v) => v + 1);
      } catch (error) {
        setLastError(error instanceof Error ? error.message : "Saving the reply failed.");
      }

      if (outcome.status === "error") {
        setLastError(outcome.error ?? "The agent request failed.");
      }

      /* Rolling summaries keep long sessions usable. */
      void maybeRollSummary(conversationId, resolveAgentModel(onlineRef.current));
    },
    [patchStreamingMessage],
  );

  const send = useCallback(
    async (text: string, attachments: AttachmentMeta[]) => {
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;
      /* Guard against a stuck request: check the state machine AND the ref.
       * If the state says we're mid-request but the ref is somehow clear
       * (a race), force-clear both so the user is never permanently blocked. */
      if (streamingIdRef.current) {
        toast("Aether is busy finishing the current reply — try again in a moment.");
        return;
      }

      /* "/task <goal>" launches the full agent runtime (attachments ride along). */
      if (trimmed === "/task" || trimmed.startsWith("/task ")) {
        if (trimmed.length > 6) await startTaskRef.current(trimmed.slice(5), attachments);
        return;
      }

      setView("chat");
      let conversationId = activeIdRef.current;
      try {
        if (!conversationId) {
          const conversation = await ConversationStore.create({
            title: trimmed || (attachments[0]?.name ?? "New conversation"),
            projectId: projectFilterRef.current,
          });
          conversationId = conversation.id;
          setActiveId(conversationId);
          setMessages([]);
          setConversations(await ConversationStore.list());
        }

        const userMessage: Message = {
          id: uid(),
          conversationId,
          role: "user",
          content: trimmed,
          status: "complete",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          attachments: attachments.length > 0 ? attachments : undefined,
        };
        setMessages((prev) => [...prev, userMessage]);
        await ConversationStore.saveMessage(userMessage);
        await ConversationStore.touch(conversationId);
        setConversations(await ConversationStore.list());
        setStatsVersion((v) => v + 1);

        await runAgent(conversationId, trimmed);
      } catch (error) {
        setLastError(error instanceof Error ? error.message : "Sending the message failed.");
        toast("Sending failed — the workspace could not be written.", "danger");
      }
    },
    [runAgent],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const retry = useCallback(
    async (assistantMessageId: string) => {
      const target = messages.find((m) => m.id === assistantMessageId);
      if (!target || streamingIdRef.current) return;
      const index = messages.findIndex((m) => m.id === assistantMessageId);
      const promptSource = [...messages.slice(0, index)].reverse().find((m) => m.role === "user");
      if (!promptSource) return;
      try {
        await ConversationStore.deleteMessage(assistantMessageId);
        setMessages((prev) => prev.filter((m) => m.id !== assistantMessageId));
        await runAgent(target.conversationId, promptSource.content);
      } catch {
        toast("Retry failed to start.", "danger");
      }
    },
    [messages, runAgent],
  );

  /* ---------------- agent runtime (Phase 2) ---------------- */

  /** Execute a persisted task inside a conversation, streaming into a message. */
  const runTaskInternal = useCallback(
    async (task: RuntimeTask, conversationId: string, assistantMessageId: string) => {
      streamingIdRef.current = assistantMessageId;
      taskBufferRef.current = "";
      setAgentPhase(phaseOf(task) === "planning" ? "planning" : "executing");
      setLastError(null);

      const conversation = await ConversationStore.get(conversationId);
      let context;
      try {
        context = await assembleContext({
          conversationId,
          projectId: conversation?.projectId ?? task.projectId,
          goal: task.goal,
        });
      } catch {
        context = { goal: task.goal, recent: [], relevantHistory: [], memory: [], files: [] };
      }

      const model = resolveAgentModel(onlineRef.current);
      const streaming = settingsRef.current.streaming;

      const runtime = new AgentRuntime(task, {
        model,
        fallbackModel: model === mockAgentModel ? undefined : mockAgentModel,
        tools: registryRef.current ?? createDefaultRegistry(),
        context,
        streaming,
        /* Real executions (npm install, crawls) legitimately take minutes. */
        toolTimeoutMs: 120_000,
        onEvent: (event) => {
          if (event.type === "delta") {
            taskBufferRef.current += event.text;
            if (streaming) {
              patchStreamingMessage(assistantMessageId, { content: taskBufferRef.current });
            }
          } else if (event.type === "phase") {
            if (
              event.phase === "planning" ||
              event.phase === "executing" ||
              event.phase === "waiting" ||
              event.phase === "paused" ||
              event.phase === "validating"
            ) {
              setAgentPhase(event.phase);
            }
          }
        },
        onSnapshot: (snapshot) => {
          setLiveTask(snapshot);
          void TaskStore.save(snapshot).catch(() => {});
          patchStreamingMessage(assistantMessageId, { runtime: snapshotOf(snapshot) });
        },
      });
      runtimeRef.current = runtime;
      setRequestState("tool");

      let finished: RuntimeTask;
      try {
        finished = await runtime.run();
      } finally {
        /* GUARANTEED terminal transition for the agent-task path too. */
        runtimeRef.current = null;
        streamingIdRef.current = null;
        setAgentPhase("idle");
      }

      const messageStatus =
        finished.status === "completed" ? "complete" : finished.status === "cancelled" ? "stopped" : "error";
      /* Real-tool artifacts and Phase 4 media assets render as attachments. */
      const messageAttachments: Message["attachments"] = [
        ...(finished.artifacts ?? []).map((a) => ({
          id: a.id,
          kind: a.mimeType.startsWith("image/") ? ("image" as const) : ("file" as const),
          name: a.name,
          mimeType: a.mimeType,
          size: a.size,
          url: a.url,
        })),
        ...(finished.attachments ?? []),
      ];
      const finalMessage: Message = {
        id: assistantMessageId,
        conversationId,
        role: "assistant",
        content: taskBufferRef.current || finished.output || "",
        status: messageStatus,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        runtime: snapshotOf(finished),
        error: finished.status === "failed" ? finished.error : undefined,
        attachments: messageAttachments.length > 0 ? messageAttachments : undefined,
      };
      patchStreamingMessage(assistantMessageId, finalMessage);
      /* Commit the message before the phase flips to idle (no Ready flash
         ahead of the rendered result). */
      setAgentPhase("idle");

      try {
        await ConversationStore.saveMessage(finalMessage);
        await ConversationStore.touch(conversationId);
        setConversations(await ConversationStore.list());
        setTasks(await TaskStore.list());
        setStatsVersion((v) => v + 1);
      } catch (error) {
        setLastError(error instanceof Error ? error.message : "Saving the task result failed.");
      }

      if (finished.status === "failed") {
        setLastError(finished.error ?? "The task failed.");
      }
      void maybeRollSummary(conversationId, model);
    },
    [patchStreamingMessage],
  );

  /** Start a new multi-step agent task from a goal (with optional attachments). */
  const startTask = useCallback(
    async (goal: string, attachments: AttachmentMeta[] = []) => {
      const trimmed = goal.trim();
      if (!trimmed) return;
      if (streamingIdRef.current) {
        toast("Aether is busy finishing the current reply — try again in a moment.");
        return;
      }
      setView("chat");
      try {
        let conversationId = activeIdRef.current;
        if (!conversationId) {
          const conversation = await ConversationStore.create({
            title: truncate(trimmed, 48),
            projectId: projectFilterRef.current,
          });
          conversationId = conversation.id;
          setActiveId(conversationId);
          setMessages([]);
          setConversations(await ConversationStore.list());
        }
        const conversation = await ConversationStore.get(conversationId);
        const task = await TaskStore.create({
          conversationId,
          projectId: conversation?.projectId ?? projectFilterRef.current,
          goal: trimmed,
        });

        const userMessage: Message = {
          id: uid(),
          conversationId,
          role: "user",
          content: trimmed,
          status: "complete",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          attachments: attachments.length > 0 ? attachments : undefined,
        };
        setMessages((prev) => [...prev, userMessage]);
        await ConversationStore.saveMessage(userMessage);
        await ConversationStore.touch(conversationId);
        setConversations(await ConversationStore.list());

        const assistantId = uid();
        setMessages((prev) => [
          ...prev,
          {
            id: assistantId,
            conversationId,
            role: "assistant",
            content: "",
            status: "streaming",
            createdAt: Date.now() + 1,
            updatedAt: Date.now() + 1,
            runtime: { taskId: task.id, phase: "planning", steps: [] },
          },
        ]);
        setTasks(await TaskStore.list());
        await runTaskInternal(task, conversationId, assistantId);
      } catch (error) {
        streamingIdRef.current = null;
        abortRef.current = null;
        setAgentPhase("idle");
        setRequestState("error");
        setLastError(error instanceof Error ? error.message : "Starting the task failed.");
        toast("The task could not be started.", "danger");
      }
    },
    [runTaskInternal],
  );

  /** Retry a failed/cancelled task, or resume an interrupted one. */
  const rerunTask = useCallback(
    async (taskId: string) => {
      if (streamingIdRef.current) return;
      const stored = await TaskStore.get(taskId);
      if (!stored) return;
      const next: RuntimeTask = {
        ...structuredClone(stored),
        status: "pending",
        error: undefined,
        finishedAt: undefined,
        steps: structuredClone(stored.steps).map((s) =>
          s.state === "failed" || s.state === "running"
            ? { ...s, state: "pending" as const, error: undefined, attempts: 0, startedAt: undefined }
            : s,
        ),
      };
      await TaskStore.save(next);
      setActiveId(next.conversationId);
      setView("chat");
      await loadMessages(next.conversationId);

      const assistantId = uid();
      setMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          conversationId: next.conversationId,
          role: "assistant",
          content: "",
          status: "streaming",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          runtime: snapshotOf(next),
        },
      ]);
      await runTaskInternal(next, next.conversationId, assistantId);
    },
    [loadMessages, runTaskInternal],
  );

  const pauseTask = useCallback(() => runtimeRef.current?.pause(), []);
  const resumeTask = useCallback(() => runtimeRef.current?.resume(), []);
  const cancelTask = useCallback(() => runtimeRef.current?.cancel(), []);
  const resolveApproval = useCallback((requestId: string, approved: boolean) => {
    runtimeRef.current?.resolveApproval(requestId, approved);
  }, []);

  /* Keeps `send` (declared earlier) able to launch tasks. */
  const startTaskRef = useRef<(goal: string, attachments?: AttachmentMeta[]) => Promise<void>>(async () => {});
  useEffect(() => {
    startTaskRef.current = startTask;
  }, [startTask]);

  const updateInstructions = useCallback(async (projectId: string, instructions: string) => {
    await ProjectStore.updateInstructions(projectId, instructions);
    setProjects(await ProjectStore.list());
  }, []);

  /* ---------------- conversation actions ---------------- */

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    streamingIdRef.current = null;
    setActiveId(null);
    setMessages([]);
    setMessagesLoading(false);
    setView("chat");
    setAgentPhase("idle");
    setRequestState("idle");
    setLastError(null);
  }, []);

  const openConversation = useCallback(
    (id: string) => {
      if (streamingIdRef.current) abortRef.current?.abort();
      setActiveId(id);
      setView("chat");
      setLastError(null);
      void loadMessages(id);
    },
    [loadMessages],
  );

  const renameConversation = useCallback(async (id: string, title: string) => {
    const clean = title.trim();
    if (!clean) return;
    await ConversationStore.patch(id, { title: truncate(clean, 64) });
    setConversations(await ConversationStore.list());
  }, []);

  const deleteConversation = useCallback(
    async (id: string) => {
      try {
        if (streamingIdRef.current && activeIdRef.current === id) abortRef.current?.abort();
        await ConversationStore.remove(id);
        setConversations(await ConversationStore.list());
        setStatsVersion((v) => v + 1);
        if (activeIdRef.current === id) {
          setActiveId(null);
          setMessages([]);
        }
        toast("Conversation deleted");
      } catch {
        toast("Delete failed.", "danger");
      }
    },
    [],
  );

  const clearMessages = useCallback(
    async (id: string) => {
      await ConversationStore.clearMessages(id);
      setMessages([]);
      setStatsVersion((v) => v + 1);
      toast("Messages cleared");
    },
    [],
  );

  /* ---------------- projects ---------------- */

  const createProject = useCallback(async (name: string) => {
    const clean = name.trim();
    if (!clean) return;
    await ProjectStore.create(clean);
    setProjects(await ProjectStore.list());
  }, []);

  const removeProject = useCallback(async (id: string) => {
    await ProjectStore.remove(id);
    setProjects(await ProjectStore.list());
    setConversations(await ConversationStore.list());
    if (projectFilterRef.current === id) setProjectFilter(null);
  }, []);

  const selectProject = useCallback((id: string | null) => {
    setProjectFilter(id);
  }, []);

  /* ---------------- settings & data ---------------- */

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = await SettingsStore.update(patch);
    setSettings(next);
  }, []);

  const exportData = useCallback(async () => {
    await exportWorkspace();
    toast("Workspace exported as JSON", "ok");
  }, []);

  const wipeData = useCallback(async () => {
    abortRef.current?.abort();
    runtimeRef.current?.cancel();
    runtimeRef.current = null;
    mediaEngine.cancelAll();
    await wipeWorkspace();
    setConversations([]);
    setProjects([]);
    setMessages([]);
    setActiveId(null);
    setView("chat");
    setTasks([]);
    setLiveTask(null);
    setStatsVersion((v) => v + 1);
    toast("Workspace wiped", "ok");
  }, []);

  /* ---------------- slash commands ---------------- */

  const handleCommand = useCallback(
    async (name: string, arg: string): Promise<SlashResult> => {
      switch (name) {
        case "new":
          newChat();
          return { handled: true };
        case "clear":
          if (activeIdRef.current) await clearMessages(activeIdRef.current);
          return { handled: true };
        case "title":
          if (!arg.trim()) return { handled: false, insert: "/title " };
          if (activeIdRef.current) {
            await renameConversation(activeIdRef.current, arg);
            toast("Conversation renamed", "ok");
          }
          return { handled: true };
        case "export":
          await exportData();
          return { handled: true };
        case "task":
          if (!arg.trim()) return { handled: false, insert: "/task " };
          /* Fire-and-forget: the composer must clear instantly while the
             task runs in the background. */
          void startTask(arg);
          return { handled: true };
        default:
          return { handled: false };
      }
    },
    [clearMessages, exportData, newChat, renameConversation, startTask],
  );

  /* ---------------- global hotkeys ---------------- */

  const hotkeyRef = useRef<(event: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const handler = (event: KeyboardEvent) => hotkeyRef.current(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  /* ---------------- derived ---------------- */

  const visibleConversations = useMemo(
    () =>
      projectFilter === null
        ? conversations
        : conversations.filter((c) => c.projectId === projectFilter),
    [conversations, projectFilter],
  );

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );

  /* A chat request is in flight when the state machine is mid-request.
   * Safety net: if the state is stuck mid-request for >3 minutes with no
   * active AbortController, force it to a terminal state so the user is
   * never permanently blocked. This can only happen if the finally block
   * somehow didn't run (e.g., a hard error before the try/catch). */
  const midRequest =
    requestState === "connecting" || requestState === "streaming" || requestState === "tool";
  const streaming = midRequest && Boolean(streamingIdRef.current);

  /* Watchdog: clear a stuck state after 3 minutes of no active controller. */
  useEffect(() => {
    if (!midRequest) return;
    const timer = setTimeout(() => {
      if (!streamingIdRef.current) {
        // No active request — the state is stale. Force terminal.
        setRequestState("error");
        setAgentPhase("idle");
      }
    }, 3 * 60_000);
    return () => clearTimeout(timer);
  }, [midRequest]);

  return {
    booted,
    bootError,
    settings,
    conversations,
    visibleConversations,
    activeId,
    activeConversation,
    view,
    messages,
    messagesLoading,
    projects,
    projectFilter,
    agentPhase,
    requestState,
    streaming,
    lastError,
    statsVersion,
    registerHotkeys: (fn: (event: KeyboardEvent) => void) => {
      hotkeyRef.current = fn;
    },
    isModKey,
    send,
    stop,
    retry,
    newChat,
    openConversation,
    renameConversation,
    deleteConversation,
    clearMessages,
    createProject,
    removeProject,
    selectProject,
    updateInstructions,
    setView,
    updateSettings,
    exportData,
    wipeData,
    handleCommand,
    /* Phase 2 — agent runtime */
    tasks,
    liveTask,
    startTask,
    rerunTask,
    pauseTask,
    resumeTask,
    cancelTask,
    resolveApproval,
    retryBoot: () => {
      setBooted(false);
      void boot();
    },
    touchFiles: () => setStatsVersion((v) => v + 1),
  };
}

export type Aether = ReturnType<typeof useAether>;
