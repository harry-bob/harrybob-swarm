import { LLMProvider } from "./types.js";
import { OpenAIProvider } from "./openai.js";
import { OllamaProvider } from "./ollama.js";
import { OpenRouterProvider } from "./openrouter.js";
import { XiaomiProvider } from "./xiaomi.js";

export interface ProviderOptions {
  model?: string;
  baseURL?: string;
  apiKey?: string;
}

export function createProvider(providerName: string, options?: ProviderOptions): LLMProvider {
  switch (providerName.toLowerCase()) {
    case "openai":
      return new OpenAIProvider(options?.apiKey, options?.baseURL);
    case "ollama":
      return new OllamaProvider({ baseURL: options?.baseURL, model: options?.model });
    case "openrouter":
      return new OpenRouterProvider({ apiKey: options?.apiKey, baseURL: options?.baseURL });
    case "xiaomi":
      return new XiaomiProvider({ apiKey: options?.apiKey, baseURL: options?.baseURL });
    default:
      throw new Error(`Unknown provider: ${providerName}. Supported: ollama, openai, openrouter, xiaomi`);
  }
}
