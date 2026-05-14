# Agent Implementations

## LLMAgent (`llm-agent.ts`)

Core wrapper around an LLM provider with a streaming tool-calling loop.

### Execution Flow

```
LLMAgent.startTask(task)
│
├─ Push system prompt + task messages onto history.
├─ Reset tool cache and modification tracking.
│
└─ Loop (no hard iteration limit):
    ├─ Compact history if > 32 messages (keep first 2 + last 8, summarize middle).
    ├─ Stream provider response.
    ├─ If response contains tool calls:
    │   ├─ Execute each tool in parallel.
    │   ├─ Track modifying tools (write_file, edit_file, run_command).
    │   ├─ Cache read-only tool results.
    │   ├─ Append tool results to history as user messages.
    │   └─ Continue.
    └─ If response is text only:
        └─ Return { output, tokenUsage }.
```

### Properties

| Property | Description |
|----------|-------------|
| `role` | Agent identity, e.g. `coder:task-1` |
| `model` | Model name passed to the provider |
| `provider` | Ollama or OpenAI provider instance |
| `tools` | `ToolRegistry` containing callable tools |
| `hasModifiedFiles()` | Returns `true` if the agent called `write_file`, `edit_file`, or `run_command` in the current conversation |

### Conversation Continuity

- `startTask()` initializes a fresh conversation with system prompt + task.
- `continueChat(userMessage)` appends a user message and runs the tool loop again.
- Full history is preserved across review rounds so the coder remembers all prior edits and feedback.

### History Compaction

When history exceeds **32 messages**:
1. Keep the first 2 messages (system + initial task).
2. Keep the last 8 messages (recent turns).
3. Summarize the middle section into a `[Context compressed]` system message.

This prevents context-window bloat during long review loops.

### Streaming

- Uses `provider.chatStream()` for real-time tokens.
- Reasoning tokens prefixed with 💭.
- TPS (tokens/sec) displayed during generation.

## BaseAgent (`base.ts`)

Abstract interface implemented by all agents.

```typescript
interface AgentTask {
  id: string;
  description: string;
  context?: string;
  messages: Message[];
}

interface AgentResult {
  taskId: string;
  agentRole: string;
  output: string;
  tokenUsage: { prompt: number; completion: number };
  duration: number;
}
```
