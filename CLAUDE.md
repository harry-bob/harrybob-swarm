# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Swarm is a CLI multi-agent coding tool (`@harrybob/swarm-cli`) that takes a task description and automatically plans, codes, and reviews the implementation using LLM-powered agents. Built in TypeScript, runs on Node.js 18+.

## Commands

- `npm run build` — bundle with tsup (ESM, single `dist/index.js`)
- `npm run dev` — run from source via tsx
- `npm test` — run tests with vitest (currently no test files exist)
- `npm run lint` — eslint (no config file present; lint may fail)
- `npm start` — run built output

Run locally during development: `npx tsx src/index.ts run "your task"` or `npx tsx src/index.ts` for interactive chat.

## Architecture

Three-phase pipeline: **Plan → Execute → Summarize**.

### Pipeline Flow

1. **ArchitectAgent** investigates the codebase via tool-use loops (up to 12 rounds), produces a JSON task plan with subtasks, dependencies, and verification commands. Plan is validated with Zod schemas and checked for cycles/vagueness.

2. **Orchestrator** (`src/core/orchestrator.ts`) executes subtasks sequentially respecting the dependency graph. Each subtask runs: **Coder** → 2 parallel **Reviewers** (consensus required) → optional Architect replan. If the coder makes no file changes, a "stubborn retry" fires (up to 2x). Reviewer feedback loops back to coder up to 3 rounds.

3. Session saved to `.swarm-session.json`.

### Key Layers

- **`src/agents/llm-agent.ts`** — Core agent class. Manages conversation history, tool execution loop (up to 15 rounds), streaming responses, read-only tool caching, history compaction (>32 messages → summarize middle, keep head+tail), file-modification tracking.
- **`src/agents/base.ts`** — Abstract `BaseAgent` with `execute(task)` contract.
- **`src/core/architect.ts`** — `ArchitectAgent` with investigation + planning phases, supports dynamic replanning.
- **`src/providers/`** — All implement `LLMProvider` interface (`chat`, `chatStream`, `listModels`). Ollama is primary/default. OpenRouter and Xiaomi have full SSE streaming with tool-call fragment assembly. OpenAI is basic non-streaming.
- **`src/tools/`** — Tool system: `ToolRegistry` (map-based), `Sandbox` (path traversal prevention), `FileCache` (invalidation on write), `runCommand` (process group kill on timeout, 10MB buffer).
- **`src/cli/tui.ts`** — Alternate-screen terminal UI with scroll, slash-command autocomplete, paste mode, 30fps rendering.
- **`src/config/config.ts`** — Reads/writes `.swarmrc.json`.

### Per-Role Tool Sets (defined in orchestrator)

- **Architect**: read_file, list_files, ask_user_question, web_search, research
- **Coder**: read_file, write_file, edit_file, list_files, run_command, web_search
- **Reviewer**: read_file, list_files, run_command, write_file, do_test, return_review

### CLI Commands

`swarm run <task>`, `swarm fix <issue>`, `swarm chat`, `swarm init`, `swarm status`, `swarm model select/set/show/list`, `swarm ollama list/pull/test`, `swarm login`.

## Config & Environment

- `.swarmrc.json` — project config (provider, model, agent settings). Gitignored.
- `.swarm-session.json` — last session state. Gitignored.
- Environment variables: `TAVILY_API_KEY`, `OPENROUTER_API_KEY`, `XIAOMI_API_KEY`, `XIAOMI_BASE_URL`, `OLLAMA_MODEL`, `OPENAI_API_KEY`, `HF_TOKEN`, `SWARM_NO_BETA_BANNER`.
- `.env` files loaded from both the package root and CWD.

## Key Patterns

- LLM calls wrapped in `withRetry()` (5 attempts, 10s backoff) in both `LLMAgent` and `ArchitectAgent`.
- History compaction triggers at >32 messages to stay within context windows.
- Read-only tool results (`read_file`, `list_files`, `web_search`) are cached per-agent.
- All file ops go through `Sandbox.validate()` — path traversal is blocked, operations restricted to project root.
- Shell commands spawn with `detached: true` and kill the process group on timeout.
- Reviewer consensus: both reviewers must approve (`[STATUS: APPROVED]`); disagreement loops back to coder.

## Build Output

- ESM only, single bundle at `dist/index.js` + sourcemap
- tsup config: `src/index.ts` entry, clean build, no declaration files
- TypeScript: ES2022 target, strict mode, bundler resolution
