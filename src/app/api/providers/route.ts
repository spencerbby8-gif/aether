import type { ProviderDescriptor } from "@/providers/types";

export const dynamic = "force-dynamic";

/**
 * Provider registry — Phase 5 ships one real chat surface: the Kaggle
 * engine fleet, woken/discovered via ensure-alive and shut down via
 * engine-off. The remote-model slot activates when AETHER_AGENT_URL is
 * configured server-side. Nothing is hardcoded.
 */
export async function GET() {
  const remoteConfigured = Boolean(process.env.AETHER_AGENT_URL);

  const providers: ProviderDescriptor[] = [
    {
      id: "engine-fleet",
      name: "Kaggle engine fleet (A/B)",
      location: "remote",
      description:
        "Qwen3.8-27B-Uncensored IQ4_XS on two Kaggle engines — wake/discovery via ensure-alive, shutdown via engine-off, AUTO/A/B routing.",
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

  return Response.json({ phase: 5, providers });
}
