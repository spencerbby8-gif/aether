/**
 * Aether — core domain types.
 * Phase 1: local workspace (IndexedDB) + mock agent providers.
 * These types are the contract that the future remote agent will plug into.
 */

export type Role = "user" | "assistant";

export type MessageStatus =
  | "pending"
  | "streaming"
  | "complete"
  | "stopped"
  | "error";

export type AttachmentKind = "image" | "video" | "audio" | "file";

export interface AttachmentMeta {
  id: string;
  kind: AttachmentKind;
  name: string;
  mimeType: string;
  size: number;
  /** Direct URL for server-side artifacts (screenshots, generated files). */
  url?: string;
  /** Workspace media asset reference (generated/edited/uploaded media). */
  assetId?: string;
}

/** A file produced by a real tool run (screenshot, output file, download). */
export interface ArtifactMeta {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

/** Contract returned by every real tool execution on the server. */
export interface ToolResult {
  ok: boolean;
  text: string;
  /**
   * Why a tool failed, when it did. Lets the API return an honest HTTP status
   * instead of guessing from the message text.
   *  - "policy"   refused by the security/network policy (client's fault -> 400)
   *  - "invalid"  malformed request or unknown tool (-> 400)
   *  - "upstream" the tool ran but a dependency failed (-> 502)
   */
  kind?: "policy" | "invalid" | "upstream";
  exitCode?: number;
  timedOut?: boolean;
  durationMs?: number;
  artifacts?: ArtifactMeta[];
}

/** A recorded tool/agent event attached to an assistant message. */
export interface ToolEventRecord {
  id: string;
  name: string;
  state: "running" | "done" | "error";
  detail?: string;
}

export interface Conversation {
  id: string;
  title: string;
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
  /** Rolling summary of older messages (long-context management). */
  summary?: string;
  /** Messages created before this timestamp are covered by `summary`. */
  summarizedAt?: number;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  /** Project-level instructions injected into the agent context. */
  instructions?: string;
}

/**
 * Engine routing mode for real chat.
 *  - auto: use any available engine; A→B failover allowed
 *  - a / b: strictly that engine — never silently switched
 */
export type ProviderId = "auto" | "a" | "b" | "c";

export interface Settings {
  provider: ProviderId;
  streaming: boolean;
  reduceMotion: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "auto",
  streaming: true,
  reduceMotion: false,
};

/** Normalize legacy/unknown stored values to a valid routing mode. */
export function normalizeRouting(value: unknown): ProviderId {
  return value === "a" || value === "b" || value === "c" ? value : "auto";
}

export interface ChatTurn {
  role: Role;
  content: string;
}

/**
 * Streaming protocol between agent providers and the UI.
 * Phase 2 extends it with runtime lifecycle events — the remote agent
 * must emit this same protocol. Runtime events carry only safe,
 * user-facing text; hidden chain-of-thought is never exposed.
 */
export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; id: string; name: string; state: "running" | "done" | "error"; detail?: string }
  | { type: "error"; message: string }
  | { type: "done"; model?: string }
  /* ---- Phase 2: AgentRuntime lifecycle ---- */
  | { type: "phase"; phase: RuntimePhase }
  | { type: "note"; text: string }
  | { type: "plan"; taskId: string; steps: Array<{ id: string; title: string; tool?: string }> }
  | { type: "step"; taskId: string; stepId: string; state: StepState; title: string; attempt?: number; result?: string; error?: string }
  | { type: "tool_call"; callId: string; tool: string; description?: string }
  | { type: "approval_request"; requestId: string; taskId: string; stepId: string; tool: string; description: string }
  | { type: "task_done"; taskId: string; status: TaskStatus; output?: string };

export interface AgentRequest {
  conversationId: string;
  turns: ChatTurn[];
  /** 0 = no artificial delay (buffered mode), 1 = normal pacing. */
  pace: number;
}

export interface SearchResult {
  conversation: Conversation;
  snippet: string;
}

export interface WorkspaceStats {
  conversations: number;
  messages: number;
  files: number;
  bytes: number;
  assets: number;
  mediaBytes: number;
}

/* ================================================================== */
/* Phase 4 — Multimodal media: assets, jobs, capabilities              */
/* ================================================================== */

export type MediaKind = "image" | "video" | "audio";

export type MediaJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export interface MediaJobStage {
  name: string;
  state: "pending" | "running" | "done" | "skipped" | "failed";
}

/** An asynchronous media job — generation, editing, upscaling, synthesis. */
export interface MediaJob {
  id: string;
  kind: MediaKind;
  operation: string;
  status: MediaJobStatus;
  /** 0–100. */
  progress: number;
  stages: MediaJobStage[];
  inputSummary: string;
  outputAssetIds: string[];
  error?: string;
  conversationId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type MediaAssetSource = "uploaded" | "generated" | "edited" | "derived";

/** A tracked media asset in the workspace (source or generated output). */
export interface MediaAssetMeta {
  id: string;
  kind: MediaKind;
  name: string;
  mimeType: string;
  size: number;
  source: MediaAssetSource;
  origin?: { conversationId?: string; jobId?: string; tool?: string };
  /** For edited/derived outputs: the asset they were made from. */
  derivedFrom?: string | null;
  width?: number;
  height?: number;
  durationMs?: number;
  /** The prompt/instruction that produced this asset (enables regeneration). */
  prompt?: string;
  /** Human-readable note about how this was made (honest provenance). */
  note?: string;
  createdAt: number;
}

/** What a media provider honestly supports — never fake the rest. */
export interface MediaCapabilities {
  generate?: boolean;
  edit?: boolean;
  enhance?: boolean;
  upscale?: boolean;
  tts?: boolean;
  transcribe?: boolean;
  trim?: boolean;
}

/* ================================================================== */
/* Phase 2 — Agent Runtime, Tasks, Tools, Memory, Context              */
/* ================================================================== */

/** Safe runtime lifecycle phases surfaced in the UI. */
export type RuntimePhase =
  | "planning"
  | "executing"
  | "waiting"
  | "paused"
  | "validating"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TaskStatus =
  | "pending"
  | "planning"
  | "running"
  | "waiting_approval"
  | "paused"
  | "validating"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type StepState = "pending" | "running" | "done" | "failed" | "skipped" | "declined";

export interface PlanStepSpec {
  id: string;
  title: string;
  /** Tool the planner intends to use, if any (validated against the registry). */
  tool?: string;
  intent?: string;
  /**
   * Steps that must finish before this one can start.
   *
   * Without this a plan is a flat list and the only available order is the one
   * it was written in, which means no independent work can ever overlap.
   */
  dependsOn?: string[];
  /**
   * Whether this step may run at the same time as others.
   *
   * Reads, searches and fetches are safe. Anything that writes a file, spawns a
   * process or mutates shared state is not. Omitting it means serial, so
   * forgetting to mark a step leaves it safe rather than racy.
   */
  parallelSafe?: boolean;
}

export interface TaskStep {
  id: string;
  title: string;
  state: StepState;
  attempts: number;
  tool?: string;
  intent?: string;
  /** Prerequisites that must be done before this step may start. */
  dependsOn?: string[];
  /** Whether this step was allowed to overlap with others. */
  parallelSafe?: boolean;
  /** Which dependency wave the step belongs to, for progress display. */
  wave?: number;
  result?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface Observation {
  stepId: string;
  tool?: string;
  ok: boolean;
  text: string;
}

export interface ApprovalRequest {
  id: string;
  taskId: string;
  stepId: string;
  tool: string;
  description: string;
  status: "pending" | "approved" | "declined";
  resolvedAt?: number;
}

export interface RuntimeEventRecord {
  at: number;
  text: string;
}

export interface RuntimeTask {
  id: string;
  conversationId: string;
  projectId: string | null;
  goal: string;
  mode: "task" | "chat";
  status: TaskStatus;
  steps: TaskStep[];
  observations: Observation[];
  approvals: ApprovalRequest[];
  events: RuntimeEventRecord[];
  output?: string;
  error?: string;
  model?: string;
  /** Files produced by real tool executions (screenshots, outputs). */
  artifacts?: ArtifactMeta[];
  /** Media assets produced by multimodal tools (images, video, audio). */
  attachments?: AttachmentMeta[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

/** Snapshot of runtime progress attached to an assistant message. */
export interface StepSnapshot {
  id: string;
  title: string;
  state: StepState;
  attempts: number;
  tool?: string;
}

export interface RuntimeSnapshot {
  taskId: string;
  phase: RuntimePhase;
  steps: StepSnapshot[];
  approval?: ApprovalRequest;
  notes?: string[];
  output?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  status: MessageStatus;
  createdAt: number;
  updatedAt: number;
  attachments?: AttachmentMeta[];
  events?: ToolEventRecord[];
  error?: string;
  model?: string;
  runtime?: RuntimeSnapshot;
  /** The model's reasoning text, shown in a collapsible panel. */
  thinking?: string;
  /** Latest lifecycle/status line (e.g. "Waking engine…"), shown while busy. */
  statusText?: string;
}

/* ---------------- tools ---------------- */

export interface ToolSchemaProperty {
  type: "string" | "number" | "boolean";
  description?: string;
  enum?: string[];
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolSchemaProperty>;
    required?: string[];
  };
  /** Tools marked here pause the runtime and ask the user first. */
  requiresApproval?: boolean;
}

/* ---------------- memory ---------------- */

export type MemoryScope = "fact" | "preference" | "conversation" | "project" | "task";

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  content: string;
  /** Optional anchor: conversationId, projectId or taskId. */
  refId?: string | null;
  createdAt: number;
  updatedAt: number;
}

/* ---------------- context ---------------- */

export interface RelevantHit {
  source: "conversation" | "memory" | "file";
  title: string;
  snippet: string;
  score: number;
}

export interface ContextPack {
  goal: string;
  projectInstructions?: string;
  summary?: string;
  recent: ChatTurn[];
  relevantHistory: RelevantHit[];
  memory: MemoryEntry[];
  files: Array<{ name: string; mimeType: string; size: number }>;
  /** Recent workspace media assets — reusable multimodal context. */
  mediaAssets?: Array<{ name: string; kind: string }>;
  taskState?: string;
}
