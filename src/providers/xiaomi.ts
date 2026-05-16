import { LLMProvider, ChatOptions, ChatResponse } from "./types.js";
import { StreamChunk } from "./stream-types.js";

export interface XiaomiProviderOptions {
  apiKey?: string;
  baseURL?: string;
}

export class XiaomiProvider implements LLMProvider {
  name = "xiaomi";
  private apiKey: string;
  private baseURL: string;

  constructor(options?: XiaomiProviderOptions) {
    this.apiKey = options?.apiKey || process.env.XIAOMI_API_KEY || "";
    this.baseURL =
      options?.baseURL ||
      process.env.XIAOMI_BASE_URL ||
      "";

    if (!this.apiKey) {
      throw new Error(
        "Xiaomi API key is required. Set XIAOMI_API_KEY environment variable."
      );
    }
    if (!this.baseURL) {
      throw new Error(
        "Xiaomi base URL is required. Set XIAOMI_BASE_URL environment variable or pass baseURL option."
      );
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  private buildBody(options: ChatOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: options.messages.map((m) => {
        const msg: Record<string, unknown> = {
          role: m.role,
          content: m.content,
        };
        if (m.tool_calls) {
          msg.tool_calls = m.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments:
                typeof tc.arguments === "string"
                  ? tc.arguments
                  : JSON.stringify(tc.arguments),
            },
          }));
        }
        if (m.tool_call_id) {
          msg.tool_call_id = m.tool_call_id;
        }
        return msg;
      }),
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
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
      body.response_format = { type: "json_object" };
    }

    return body;
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(this.buildBody(options)),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Xiaomi API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];

    let toolCalls = undefined;
    if (
      choice?.message?.tool_calls &&
      Array.isArray(choice.message.tool_calls)
    ) {
      toolCalls = choice.message.tool_calls.map(
        (
          tc: {
            function: {
              name: string;
              arguments: string | Record<string, unknown>;
            };
          },
          i: number
        ) => ({
          id: `call_${Date.now()}_${i}`,
          name: tc.function.name,
          arguments:
            typeof tc.function.arguments === "string"
              ? JSON.parse(tc.function.arguments)
              : tc.function.arguments,
        })
      );
    }

    return {
      content: choice?.message?.content || "",
      thinking: choice?.message?.reasoning || undefined,
      tool_calls: toolCalls,
      usage: {
        prompt: data.usage?.prompt_tokens || 0,
        completion: data.usage?.completion_tokens || 0,
        reasoning: data.usage?.completion_tokens_details?.reasoning_tokens || 0,
      },
    };
  }

  async *chatStream(
    options: ChatOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const body = { ...this.buildBody(options), stream: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300_000);

    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Xiaomi API error: ${response.status} - ${error}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      const toolCallBuffer = new Map<
        number,
        { id?: string; name?: string; arguments: string }
      >();
      let finalTokenCount = 0;
      let finalReasoningCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;

          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta || {};

            if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const index = tc.index ?? 0;
                const existing = toolCallBuffer.get(index) || {
                  arguments: "",
                };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments)
                  existing.arguments += tc.function.arguments;
                toolCallBuffer.set(index, existing);
              }
            }

            if (json.usage?.completion_tokens) {
              finalTokenCount = json.usage.completion_tokens;
            }
            if (json.usage?.completion_tokens_details?.reasoning_tokens) {
              finalReasoningCount = json.usage.completion_tokens_details.reasoning_tokens;
            }

            yield {
              content: delta.content || undefined,
              thinking: delta.reasoning || undefined,
              done: false,
            };
          } catch {
            // skip malformed SSE lines
          }
        }
      }

      const assembledToolCalls = Array.from(toolCallBuffer.entries())
        .map(([i, tc]) => ({
          id: tc.id || `call_${Date.now()}_${i}`,
          name: tc.name || "",
          arguments: tc.arguments ? JSON.parse(tc.arguments) : {},
        }))
        .filter((tc) => tc.name);

      yield {
        done: true,
        tool_calls:
          assembledToolCalls.length > 0 ? assembledToolCalls : undefined,
        tokenCount: finalTokenCount || undefined,
        reasoningTokens: finalReasoningCount || undefined,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseURL}/models`, {
      headers: this.buildHeaders(),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Xiaomi API error: ${response.status} - ${error}`);
    }
    const data = await response.json();
    return (data.data || [])
      .map((m: { id: string }) => m.id)
      .sort();
  }
}
