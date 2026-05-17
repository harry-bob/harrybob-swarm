export interface StreamChunk {
  content?: string;
  thinking?: string;
  tool_calls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  done: boolean;
  tokenCount?: number;      // completion/output tokens
  promptTokens?: number;    // input/prompt tokens
  reasoningTokens?: number; // reasoning/thinking tokens
  durationNs?: number;
}
