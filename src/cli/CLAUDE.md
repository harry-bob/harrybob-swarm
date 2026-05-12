# src/cli/

## What This Directory Contains

The CLI layer: argument parsing, interactive TUI, stream rendering, and command implementations.

## Key Files

| File | Purpose |
|------|---------|
| `index.ts` | Commander.js setup, registers all commands |
| `tui.ts` | Interactive chat terminal (banner, input bar, commands) |
| `model-picker.ts` | Model selection UI |
| `stream-renderer.ts` | Renders streaming LLM output to terminal |
| `tps-display.ts` | Tokens-per-second display during streaming |

## commands/

| File | Purpose |
|------|---------|
| `init.ts` | `swarm init` — creates `.swarmrc.json`, auto-detects model |
| `run.ts` | `swarm run <task>` — loads config, creates Orchestrator, runs |
| `fix.ts` | `swarm fix` — loads session context, runs follow-up task |
| `chat.ts` | `swarm chat` — interactive TUI loop |
| `model.ts` | `swarm model select/set/show/list` |
| `ollama.ts` | `swarm ollama pull/list` |
| `status.ts` | `swarm status` — shows last session info |

## Known Flaws

- **No shell completions**: No bash/zsh/fish completion support
- **No `--verbose` flag on all commands**: Only `run` has verbose mode
- **`swarm chat` is minimal**: No syntax highlighting, no autocomplete, no history persistence
- **`swarm init` auto-detects first model**: Picks `models[0]` from Ollama list, which may not be the best one
- **`swarm fix` loads only last session**: No way to reference older sessions
- **No `--dry-run` flag**: Can't preview what swarm would do without executing
