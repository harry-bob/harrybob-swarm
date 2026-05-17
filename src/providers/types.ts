import { ToolDefinition, ToolCall } from "../tools/types.js";
import { StreamChunk } from "./stream-types.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  thinking?: string; // reasoning_content for MiMo-style APIs
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" };
}

export interface ChatResponse {
  content: string;
  thinking?: string;
  tool_calls?: ToolCall[];
  usage: {
    prompt: number;
    completion: number;
    reasoning: number;
  };
}

export interface LLMProvider {
  name: string;
  chat(options: ChatOptions): Promise<ChatResponse>;
  chatStream(options: ChatOptions): AsyncIterable<StreamChunk>;
  listModels(): Promise<string[]>;
}
