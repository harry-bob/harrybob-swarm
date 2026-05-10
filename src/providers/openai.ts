import { LLMProvider, ChatOptions, ChatResponse } from "./types.js";
import { StreamChunk } from "./stream-types.js";

export class OpenAIProvider implements LLMProvider {
  name = "openai";
  private apiKey: string;
  private baseURL: string;

  constructor(apiKey?: string, baseURL?: string) {
    this.apiKey = apiKey || process.env.OPENAI_API_KEY || "";
    this.baseURL = baseURL || "https://api.openai.com/v1";

    if (!this.apiKey) {
      throw new Error("OpenAI API key is required. Set OPENAI_API_KEY environment variable.");
    }
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4096,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const choice = data.choices[0];

    return {
      content: choice.message.content,
      usage: {
        prompt: data.usage.prompt_tokens,
        completion: data.usage.completion_tokens,
      },
    };
  }

  async *chatStream(options: ChatOptions): AsyncGenerator<StreamChunk, void, unknown> {
    // Fallback: call non-streaming and yield as a single chunk
    const result = await this.chat(options);
    yield {
      content: result.content,
      thinking: result.thinking,
      done: true,
      tokenCount: result.usage.completion,
    };
  }
}
