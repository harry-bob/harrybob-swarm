# src/providers/

## What This Directory Contains

LLM provider abstraction: streaming completions, tool calling, and model management.

## Key Files

| File | Purpose |
|------|---------|
| `types.ts` | `Provider`, `CompletionOptions`, `CompletionResponse` interfaces |
| `ollama.ts` | `OllamaProvider` — Ollama API (local + cloud models) |
| `openai.ts` | `OpenAIProvider` — OpenAI-compatible API |
| `factory.ts` | `createProvider(name, model)` — factory function |
| `index.ts` | Re-exports |
| `stream-types.ts` | Streaming chunk types |

## OllamaProvider

- Streaming via `/api/chat` with `stream: true`
- Tool calling via `tools` parameter in chat API
- `listModels()` — lists available models
- `showModelInfo(name)` — model details
- `pullModel(name)` — downloads a model
- Default model from `OLLAMA_MODEL` env var

## Known Flaws

- **No retry on API errors**: If Ollama returns 429 or 502, the provider crashes instead of retrying
- **No connection pooling**: Each request creates a new HTTP connection
- **Cloud model routing**: Cloud models (e.g. `gemma4:31b-cloud`) are routed through `ollama.com:443` — if that endpoint is unreachable, all cloud models fail
- **No timeout on individual API calls**: The provider relies on the caller to set timeouts
- **`listModels()` returns empty array on connection failure**: No error thrown, just empty list — callers can't distinguish "no models" from "can't connect"
- **Streaming tool calls**: Tool arguments are accumulated from streaming chunks — if the stream is interrupted mid-tool-call, the partial args may cause errors
- **No model capability detection**: Can't tell if a model supports tool calling without trying
