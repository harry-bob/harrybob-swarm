# Swarm — Root

## What This Directory Contains

The root of the **swarm** project: a CLI multi-agent orchestration tool that uses LLM-powered agents to decompose tasks, research solutions, write code, and review it.

## Key Files

| File | Purpose |
|------|---------|
| `package.json` | NPM config, dependencies, build scripts |
| `tsconfig.json` | TypeScript config |
| `tsup.config.ts` | Build config (ESM output to `dist/`) |
| `.env` | Secrets: `TAVILY_API_KEY`, `HF_TOKEN`, `OLLAMA_MODEL` |
| `.env.example` | Template for `.env` |
| `src/index.ts` | Entry point (exports CLI) |
| `README.md` | Project overview |

## CLI Commands

```
swarm init       - Initialize .swarmrc.json in current directory
swarm run <task> - Run a task with the full agent pipeline
swarm fix        - Fix issues using prior session context
swarm chat       - Interactive chat terminal
swarm model      - Show/set/list models
swarm ollama     - Manage Ollama models
swarm status     - Show last run status
```

## Build & Run

```bash
npx tsup              # Build TypeScript → dist/
~/bin/swarm           # Symlink to dist/index.js
```

## Known Flaws

- No parallel subtask execution within a single `swarm run` — all subtasks run sequentially
- No cost/token tracking across sessions
- No plugin system for custom tools
- The `swarm chat` TUI is minimal (no syntax highlighting, no autocomplete)
- No retry logic for LLM failures in the orchestrator
- Session persistence only stores last run (no history)

## Flows

```
User runs `swarm run "task"`
  → CLI loads .swarmrc.json
  → Creates Orchestrator with provider (Ollama/OpenAI)
  → Orchestrator creates ArchitectAgent (Leader)
    → Leader plans task: goal + subtasks + dependencies
  → Orchestrator executes subtasks via runWorkerPair()
    → Coder agent: writes code using tools
    → Reviewer agent: reviews code, approves or requests changes
    → Loop until approved (no max iterations)
  → Save session for future `swarm fix` context
```
