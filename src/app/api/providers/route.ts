import type { ProviderDescriptor } from "@/providers/types";
import { requireControlAuth } from "@/server/auth";

export const dynamic = "force-dynamic";

/**
 * Provider registry. The real chat surface is the Kaggle engine fleet
 * (A/B/C), woken/discovered via ensure-alive and shut down via engine-off.
 * The remote-model slot activates when AETHER_AGENT_URL is configured
 * server-side. Nothing is hardcoded.
 *
 * FIX (audit B7): this describes the deployment's internal capabilities, so it
 * now requires the control token rather than answering anonymous callers.
 */
export async function GET(request: Request) {
  const denied = requireControlAuth(request);
  if (denied) return denied;

  const remoteConfigured = Boolean(process.env.AETHER_AGENT_URL);

  const providers: ProviderDescriptor[] = [
    {
      id: "engine-fleet",
      name: "Kaggle engine fleet (A/B/C)",
      location: "remote",
      description:
        "Qwen3.8-27B-Uncensored IQ4_XS across the A/B/C Kaggle engines — wake/discovery via ensure-alive, shutdown via engine-off, AUTO/A/B/C routing.",
      available: true,
    },
    {
      id: "remote-agent",
      name: "Remote agent passthrough",
      location: "remote",
      description: remoteConfigured
        ? "Connected via AETHER_AGENT_URL."
        : "Optional remote intelligence slot — configure AETHER_AGENT_URL to activate.",
      available: remoteConfigured,
    },
  ];

  return Response.json({ providers }, { headers: { "cache-control": "no-store" } });
}
