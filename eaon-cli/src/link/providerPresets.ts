// BYOK provider presets — mirrors Eaon Desktop's KnownProviderDefaults /
// ProviderBrand.byokPickerBrands so the /link browser form offers the same
// companies, base URLs, and wire formats as the Mac app.

import type { CustomProviderFormat } from "../types.js";

export interface ProviderPreset {
  id: string;
  name: string;
  baseURL: string;
  format: CustomProviderFormat;
  exampleModelID: string;
  /** Short hint shown under the provider picker when selected. */
  autoSetupNote: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openAI",
    name: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    format: "openAICompatible",
    exampleModelID: "gpt-4o",
    autoSetupNote: "Connection details for OpenAI are set up automatically.",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseURL: "https://api.anthropic.com/v1",
    format: "anthropicMessages",
    exampleModelID: "claude-sonnet-4-5",
    autoSetupNote: "Connection details for Anthropic are set up automatically.",
  },
  {
    id: "google",
    name: "Google",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    format: "googleGemini",
    exampleModelID: "gemini-2.5-flash",
    autoSetupNote: "Connection details for Google are set up automatically.",
  },
  {
    id: "mistral",
    name: "Mistral",
    baseURL: "https://api.mistral.ai/v1",
    format: "openAICompatible",
    exampleModelID: "mistral-large-latest",
    autoSetupNote: "Connection details for Mistral are set up automatically.",
  },
  {
    id: "deepSeek",
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    format: "openAICompatible",
    exampleModelID: "deepseek-chat",
    autoSetupNote: "Connection details for DeepSeek are set up automatically.",
  },
  {
    id: "xAI",
    name: "xAI",
    baseURL: "https://api.x.ai/v1",
    format: "openAICompatible",
    exampleModelID: "grok-4",
    autoSetupNote: "Connection details for xAI are set up automatically.",
  },
  {
    id: "groq",
    name: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    format: "openAICompatible",
    exampleModelID: "llama-3.3-70b-versatile",
    autoSetupNote: "Connection details for Groq are set up automatically.",
  },
  {
    id: "openRouter",
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    format: "openAICompatible",
    exampleModelID: "anthropic/claude-sonnet-4",
    autoSetupNote: "Connection details for OpenRouter are set up automatically.",
  },
  {
    id: "together",
    name: "Together AI",
    baseURL: "https://api.together.ai/v1",
    format: "openAICompatible",
    exampleModelID: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    autoSetupNote: "Connection details for Together AI are set up automatically.",
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    baseURL: "https://api.fireworks.ai/inference/v1",
    format: "openAICompatible",
    exampleModelID: "accounts/fireworks/models/llama-v3p1-8b-instruct",
    autoSetupNote: "Connection details for Fireworks AI are set up automatically.",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    baseURL: "https://api.cerebras.ai/v1",
    format: "openAICompatible",
    exampleModelID: "llama3.1-8b",
    autoSetupNote: "Connection details for Cerebras are set up automatically.",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    baseURL: "https://api.perplexity.ai",
    format: "openAICompatible",
    exampleModelID: "sonar-pro",
    autoSetupNote: "Connection details for Perplexity are set up automatically.",
  },
  {
    id: "cohere",
    name: "Cohere",
    baseURL: "https://api.cohere.ai/compatibility/v1",
    format: "openAICompatible",
    exampleModelID: "command-a-03-2025",
    autoSetupNote: "Connection details for Cohere are set up automatically.",
  },
  {
    id: "nvidia",
    name: "NVIDIA",
    baseURL: "https://integrate.api.nvidia.com/v1",
    format: "openAICompatible",
    exampleModelID: "meta/llama-3.3-70b-instruct",
    autoSetupNote: "Connection details for NVIDIA are set up automatically.",
  },
  {
    id: "custom",
    name: "Custom / other",
    baseURL: "",
    format: "openAICompatible",
    exampleModelID: "my-model-id",
    autoSetupNote: "Enter the base URL and format under Advanced settings.",
  },
];

export function presetById(id: string): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
}
