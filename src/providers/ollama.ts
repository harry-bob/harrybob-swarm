import { LLMProvider, ChatOptions, ChatResponse } from "./types.js";
import { StreamChunk } from "./stream-types.js";

export interface OllamaProviderOptions {
  baseURL?: string;
  model?: string;
}

export class OllamaProvider implements LLMProvider {
  name = "ollama";
  private baseURL: string;
  private defaultModel: string;
  private readonly CHAT_TIMEOUT_MS = 300_000; // 5 minutes
  private readonly STREAM_IDLE_MS = 60_000;  // 60 seconds without chunks

  constructor(options?: OllamaProviderOptions) {
    this.baseURL = options?.baseURL || process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    this.defaultModel = options?.model || process.env.OLLAMA_MODEL || "llama3.1";
  }

  private buildBody(options: ChatOptions, stream: boolean): Record<string, unknown> {
    const model = options.model || this.defaultModel;
    const body: Record<string, unknown> = {
      model,
      messages: options.messages.map((m) => {
        const msg: Record<string, unknown> = {
          role: m.role,
          content: m.content,
        };
        if (m.tool_calls) {
          msg.tool_calls = m.tool_calls.map((tc) => ({
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        if (m.tool_call_id) {
          msg.tool_call_id = m.tool_call_id;
        }
        return msg;
      }),
      stream,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens ?? 8192,
      },
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: {
            type: "object",
            properties: Object.fromEntries(
              Object.entries(t.parameters).map(([key, param]) => [
                key,
                { type: param.type, description: param.description },
              ])
            ),
            required: Object.entries(t.parameters)
              .filter(([, param]) => param.required !== false)
              .map(([key]) => key),
          },
        },
      }));
    }

    if (options.responseFormat?.type === "json_object") {
      body.format = "json";
    }

    return body;
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const body = this.buildBody(options, false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.CHAT_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.baseURL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Ollama API error: ${response.status} - ${error}`);
      }

      const data = await response.json();
      const message = data.message || {};

      let toolCalls = undefined;
      if (message.tool_calls && Array.isArray(message.tool_calls)) {
        toolCalls = message.tool_calls.map(
          (tc: { function: { name: string; arguments: Record<string, unknown> } }, i: number) => ({
            id: `call_${Date.now()}_${i}`,
            name: tc.function.name,
            arguments: tc.function.arguments,
          })
        );
      }

      return {
        content: message.content || "",
        thinking: message.thinking || undefined,
        tool_calls: toolCalls,
        usage: {
          prompt: data.prompt_eval_count || 0,
          completion: data.eval_count || 0,
        },
      };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  async *chatStream(options: ChatOptions): AsyncGenerator<StreamChunk, void, unknown> {
    const body = this.buildBody(options, true);
    const controller = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout>;

    function resetIdleTimer() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), 60_000);
    }

    resetIdleTimer();

    try {
      const response = await fetch(`${this.baseURL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Ollama API error: ${response.status} - ${error}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        resetIdleTimer();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);
            const msg = json.message || {};

            // Parse tool calls from stream chunk
            let toolCalls = undefined;
            if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
              toolCalls = msg.tool_calls.map(
                (tc: { function: { name: string; arguments: Record<string, unknown> } }, i: number) => ({
                  id: `call_${Date.now()}_${i}`,
                  name: tc.function.name,
                  arguments: tc.function.arguments,
                })
              );
            }

            yield {
              content: msg.content || undefined,
              thinking: msg.thinking || undefined,
              tool_calls: toolCalls,
              done: json.done || false,
              tokenCount: json.eval_count || undefined,
              durationNs: json.eval_duration || undefined,
            };
          } catch {
            // skip malformed lines
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const json = JSON.parse(buffer);
          const msg = json.message || {};

          let toolCalls = undefined;
          if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
            toolCalls = msg.tool_calls.map(
              (tc: { function: { name: string; arguments: Record<string, unknown> } }, i: number) => ({
                id: `call_${Date.now()}_${i}`,
                name: tc.function.name,
                arguments: tc.function.arguments,
              })
            );
          }

          yield {
            content: msg.content || undefined,
            thinking: msg.thinking || undefined,
            tool_calls: toolCalls,
            done: json.done || false,
            tokenCount: json.eval_count || undefined,
            durationNs: json.eval_duration || undefined,
          };
        } catch {
          // skip
        }
      }
    } finally {
      clearTimeout(idleTimer);
    }
  }

  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseURL}/api/tags`);
    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }
    const data = await response.json();
    return (data.models || []).map((m: { name: string }) => m.name);
  }

  async pullModel(model: string): Promise<void> {
    const response = await fetch(`${this.baseURL}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model }),
    });

    if (!response.ok) {
      throw new Error(`Failed to pull model: ${response.status}`);
    }
  }
}
