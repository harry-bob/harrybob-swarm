export interface StreamChunk {
  content?: string;
  thinking?: string;
  tool_calls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  done: boolean;
  tokenCount?: number;
  durationNs?: number;
}
