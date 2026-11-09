/**
 * Bring Your Own Key (BYOK) provider contracts.
 *
 * Aether stores these records only in this browser's IndexedDB. The server
 * receives the key for an individual request and never writes it to a database
 * or log. A saved key is NOT evidence that a provider is reachable.
 */

export const BYOK_PROVIDERS = [
  {
    id: "openai",
    name: "OpenAI",
    description: "GPT models through the OpenAI API.",
    baseUrl: "https://api.openai.com/v1",
    suggestedModels: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "One key for models from multiple upstream providers.",
    baseUrl: "https://openrouter.ai/api/v1",
    suggestedModels: ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4", "google/gemini-2.5-flash"],
    docsUrl: "https://openrouter.ai/settings/keys",
  },
  {
    id: "groq",
    name: "Groq",
    description: "Low-latency inference for supported open models.",
    baseUrl: "https://api.groq.com/openai/v1",
    suggestedModels: ["llama-3.3-70b-versatile", "openai/gpt-oss-20b"],
    docsUrl: "https://console.groq.com/keys",
  },
  {
    id: "mistral",
    name: "Mistral AI",
    description: "Mistral and Codestral models on La Plateforme.",
    baseUrl: "https://api.mistral.ai/v1",
    suggestedModels: ["mistral-small-latest", "mistral-large-latest"],
    docsUrl: "https://console.mistral.ai/api-keys",
  },
  {
    id: "together",
    name: "Together AI",
    description: "Open-model inference with an OpenAI-compatible API.",
    baseUrl: "https://api.together.xyz/v1",
    suggestedModels: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "deepseek-ai/DeepSeek-V3"],
    docsUrl: "https://api.together.xyz/settings/api-keys",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    description: "High-speed inference for supported Cerebras models.",
    baseUrl: "https://api.cerebras.ai/v1",
    suggestedModels: ["llama-3.3-70b", "llama3.1-8b"],
    docsUrl: "https://cloud.cerebras.ai/",
  },
  {
    id: "xai",
    name: "xAI",
    description: "Grok models through the xAI API.",
    baseUrl: "https://api.x.ai/v1",
    suggestedModels: ["grok-3-mini", "grok-3"],
    docsUrl: "https://console.x.ai/",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek chat and reasoning models.",
    baseUrl: "https://api.deepseek.com/v1",
    suggestedModels: ["deepseek-chat", "deepseek-reasoner"],
    docsUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "custom",
    name: "Custom OpenAI-compatible",
    description: "A public HTTPS endpoint implementing /models and /chat/completions.",
    baseUrl: "",
    suggestedModels: [],
    docsUrl: "",
  },
] as const;

export type ByokProviderId = (typeof BYOK_PROVIDERS)[number]["id"];

export interface ByokTestResult {
  status: "verified" | "failed";
  checkedAt: number;
  message: string;
  modelCount?: number;
}

export interface ByokConnection {
  id: string;
  provider: ByokProviderId;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  defaultModel: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastTest?: ByokTestResult;
}

export interface ByokConnectionInput {
  provider: ByokProviderId;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  defaultModel: string;
  enabled: boolean;
  lastTest?: ByokTestResult;
}

export interface ByokRequestConnection {
  provider: ByokProviderId;
  baseUrl: string;
  apiKey: string;
}

export function providerDefinition(id: ByokProviderId) {
  return BYOK_PROVIDERS.find((provider) => provider.id === id) ?? BYOK_PROVIDERS[BYOK_PROVIDERS.length - 1];
}

export function normalizeBaseUrl(raw: string, provider: ByokProviderId): string {
  const fallback = providerDefinition(provider).baseUrl;
  return (raw.trim() || fallback).replace(/\/+$/, "").replace(/\/(chat\/completions|models)$/, "");
}

export function normalizeModels(models: string[]): string[] {
  return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean))).slice(0, 100);
}

export function publicConnection(connection: ByokConnection): Omit<ByokConnection, "apiKey"> & { hasKey: boolean } {
  const { apiKey: _apiKey, ...safe } = connection;
  return { ...safe, hasKey: _apiKey.length > 0 };
}
