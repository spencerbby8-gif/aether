import { brainPlan, brainStep, brainSummarize, brainValidate } from "@/agent/brain";
import { requireControlAuth } from "@/server/auth";
import type { ContextPack, Observation, TaskStep, ToolSchema } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Aether model endpoint — the intelligence socket for the AgentRuntime.
 * Phase 2 answers with the deterministic mock brain. When AETHER_AGENT_URL
 * is configured, requests pass through to the remote model unchanged.
 * No provider endpoint or credential is hardcoded anywhere.
 */

interface ModelBody {
  mode?: string;
  goal?: string;
  tools?: ToolSchema[];
  context?: ContextPack;
  currentStep?: TaskStep;
  steps?: TaskStep[];
  observations?: Observation[];
  corrections?: string[];
  output?: string;
  texts?: string[];
}

const EMPTY_CONTEXT: ContextPack = {
  goal: "",
  recent: [],
  relevantHistory: [],
  memory: [],
  files: [],
};

export async function POST(request: Request) {
  /* FIX (audit B7): this endpoint proxies to AETHER_AGENT_URL using the server's
     AETHER_AGENT_KEY. Unauthenticated, it was an open relay that spent someone
     else's model credentials. */
  const denied = requireControlAuth(request);
  if (denied) return denied;

  let body: ModelBody;
  try {
    body = (await request.json()) as ModelBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const mode = body.mode;
  if (mode !== "plan" && mode !== "step" && mode !== "validate" && mode !== "summarize") {
    return Response.json({ error: `Unknown mode "${String(mode)}".` }, { status: 400 });
  }

  /* Generic remote-model passthrough — activates only when configured. */
  const remoteUrl = process.env.AETHER_AGENT_URL;
  if (remoteUrl) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (process.env.AETHER_AGENT_KEY) headers.authorization = `Bearer ${process.env.AETHER_AGENT_KEY}`;
    try {
      const upstream = await fetch(remoteUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ protocol: "aether.agent/v1", ...body }),
        signal: request.signal,
      });
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      });
    } catch {
      return Response.json({ error: "The remote model could not be reached." }, { status: 502 });
    }
  }

  const goal = typeof body.goal === "string" ? body.goal : "";
  const tools = Array.isArray(body.tools) ? body.tools : [];

  if (mode === "plan") {
    return Response.json(brainPlan(goal, tools));
  }

  if (mode === "step") {
    const currentStep = body.currentStep;
    if (!currentStep || typeof currentStep.title !== "string") {
      return Response.json({ error: "A valid currentStep is required." }, { status: 400 });
    }
    const decision = brainStep({
      goal,
      context: body.context ?? EMPTY_CONTEXT,
      steps: Array.isArray(body.steps) ? body.steps : [],
      currentStep,
      observations: Array.isArray(body.observations) ? body.observations : [],
      corrections: Array.isArray(body.corrections) ? body.corrections : [],
      tools,
    });
    return Response.json(decision);
  }

  if (mode === "validate") {
    return Response.json(
      brainValidate({
        goal,
        steps: Array.isArray(body.steps) ? body.steps : [],
        output: typeof body.output === "string" ? body.output : "",
        observations: Array.isArray(body.observations) ? body.observations : [],
      }),
    );
  }

  /* summarize */
  const texts = Array.isArray(body.texts) ? body.texts.filter((t): t is string => typeof t === "string") : [];
  return Response.json({ summary: brainSummarize(texts) });
}
