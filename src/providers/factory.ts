import { LLMProvider } from "./types.js";
import { OpenAIProvider } from "./openai.js";
import { OllamaProvider } from "./ollama.js";

export function createProvider(providerName: string, model?: string): LLMProvider {
  switch (providerName.toLowerCase()) {
    case "openai":
      return new OpenAIProvider();
    case "ollama":
      return new OllamaProvider({ model });
    default:
      throw new Error(`Unknown provider: ${providerName}. Supported: openai, ollama`);
  }
}
