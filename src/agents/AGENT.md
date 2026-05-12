# Agent Implementations

## LLMAgent (`llm-agent.ts`)

The core agent class that all agents use. Wraps an LLM provider with a tool-calling loop.

### Execute Flow

```
LLMAgent.execute(task)
  │
  ├─ Add system prompt + task messages to context
  │
  └─ Loop (no max iterations):
      ├─ Call LLM with messages + tool definitions
      ├─ If LLM returns tool calls:
      │   ├─ Execute each tool
      │   ├─ Add tool results to messages
      │   └─ Continue loop
      └─ If LLM returns text only:
          └─ Return AgentResult { output, tokenUsage }
```

### Key Properties

- `role` — identifies the agent (e.g. `coder:task-1`)
- `model` — LLM model name
- `provider` — Ollama/OpenAI provider instance
- `tools` — ToolRegistry with available tools
- `hasModifiedFiles` — tracks if write_file/edit_file/run_command were called

### Streaming

- Uses `provider.stream()` for real-time output
- Thinking/reasoning displayed with 💭 prefix
- TPS (tokens/sec) meter shown during generation

## BaseAgent (`base.ts`)

Abstract class defining the agent interface:

```typescript
interface AgentTask {
  id: string;
  description: string;
  messages: Message[];
}

interface AgentResult {
  output: string;
  tokenUsage: { prompt: number; completion: number };
  agentRole: string;
  duration: number;
}
```
