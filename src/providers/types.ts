import type { AgentEvent, AgentRequest } from "@/lib/types";

/**
 * The contract every agent backend must satisfy.
 * Phase 5: chat runs exclusively on the real Kaggle engine fleet through
 * /api/agent/stream (NDJSON). This interface remains for future backends.
 */
export interface AIProvider {
  readonly id: string;
  readonly name: string;
  readonly location: "local" | "server" | "remote";
  stream(request: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
}

export interface ProviderDescriptor {
  id: string;
  name: string;
  location: "local" | "server" | "remote";
  description: string;
  available: boolean;
}
