# src/agents/

## What This Directory Contains

Base and LLM-powered agent implementations. These are the workers that execute tasks using tool-calling loops.

## Key Files

| File | Purpose |
|------|---------|
| `base.ts` | `BaseAgent` abstract class — task interface, result types |
| `llm-agent.ts` | `LLMAgent` — streaming LLM calls with tool calling, thinking display, TPS meter |

## Architecture

```
BaseAgent (abstract)
  ├── execute(task) → AgentResult
  ├── abstract runOnce(messages) → response
  └── abstract runTools(calls) → results

LLMAgent extends BaseAgent
  ├── Streaming with thinking/reasoning display (💭)
  ├── Tool calling loop (LLM calls tool → result → LLM continues)
  ├── No max iterations — runs until LLM naturally stops
  └── TPS (tokens per second) meter
```

## Known Flaws

- **No token limit on context**: If the LLM generates very long responses, the context can grow unbounded within a single `execute()` call
- **No retry on LLM failures**: If the LLM returns an error, the agent crashes
- **Tool output truncation removed**: Originally had 10K char limit, now unlimited — very long tool outputs can cause context overflow
- **No streaming cancellation**: Once a streaming response starts, it can't be cancelled mid-stream
- **TPS meter is approximate**: Uses word-based estimation, not actual token counting
- **`hasModifiedFiles` tracking**: Only counts write_file, edit_file, run_command as "work done" — read_file doesn't count, so stubborn retry works correctly
