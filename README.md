# 🐝 Swarm

A CLI multi-agent coding tool. Give it a task, and it plans, codes, and reviews — automatically.

Powered by [Ollama](https://ollama.com) and built in TypeScript.

## Quick Start

### Install from npm (recommended)

```bash
# Install globally
npm install -g @harrybob/swarm-cli

# Or use per-project with npx
npx @harrybob/swarm-cli init
npx @harrybob/swarm-cli run "create a Python REST API with auth"
```

### Prerequisites

You need [Ollama](https://ollama.com) running locally or a cloud endpoint:

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model
ollama pull nemotron-3-super:cloud
```

### Development install (from source)

```bash
git clone https://github.com/harry-bob/harrybob-swarm.git
cd harrybob-swarm
npm install
npm run build
npm link

# Use it in any project
cd your-project
swarm init
swarm run "create a Python REST API with auth"
```

## How It Works

```
You: "build a todo list API"
          ↓
    🧠 Architect
    Analyzes task, creates subtask plan
          ↓
    ⚡ Parallel Execution
    ┌─────────┬─────────┐
    │ Coder→  │ Coder→  │
    │Reviewer │Reviewer │  ← loop until approved
    └─────────┴─────────┘
          ↓
    ✅ Done — files created, session saved
```

**Architect** — reads your codebase, breaks the task into subtasks with dependencies, asks you questions if anything is unclear.

**Coder** — writes code using real tools: read files, write files, edit files, run shell commands, search the web.

**Reviewer** — reads the code, runs it, checks for bugs and issues. Kicks it back to the coder if it's not good enough. No round limits — they keep going until the reviewer approves.

## Commands

| Command | Description |
|---------|-------------|
| `swarm init` | Set up swarm in the current directory |
| `swarm run <task>` | Run a task through the full pipeline |
| `swarm fix <issue>` | Fix a bug using context from the last run |
| `swarm chat` | Interactive mode — type tasks, get results |
| `swarm model select` | Pick a model interactively |
| `swarm model set <name>` | Set model directly |
| `swarm model show` | Show current model |
| `swarm model list` | List available Ollama models |
| `swarm status` | Show config and last session info |
| `swarm ollama list` | List Ollama models |

## Interactive Mode

```bash
swarm chat
```

```
╔══════════════════════════════════════════════════════════════╗
║  🐝 SWARM — Interactive Mode                               ║
╠══════════════════════════════════════════════════════════════╣
║  Type a task to create something                            ║
║  fix <issue>     — fix a bug from the previous task         ║
║  model select    — pick a model interactively               ║
║  status          — show swarm configuration                 ║
║  exit            — exit interactive mode                    ║
╚══════════════════════════════════════════════════════════════╝

> create a REST API for todo list
  [architect] 📦 3 subtask(s)
  [coder:task-1] ⚙ write_file(path: "app.py")
  [reviewer:task-1] ✅ Approved
```

## Configuration

`swarm init` creates `.swarmrc.json` in your project:

```json
{
  "version": "1.0.0",
  "provider": "ollama",
  "model": "nemotron-3-super:cloud",
  "baseURL": "http://localhost:11434",
  "agents": {
    "researcher": { "role": "researcher", "systemPrompt": "..." },
    "coder": { "role": "coder", "systemPrompt": "..." },
    "reviewer": { "role": "reviewer", "systemPrompt": "..." }
  },
  "orchestration": {
    "maxConcurrentAgents": 3,
    "timeout": 0
  },
  "disabledTools": []
}
```

### Disabling Tools

Restrict what agents can do per-project:

```json
{
  "disabledTools": ["web_search", "ask_user_question"]
}
```

Available tools to disable: `web_search`, `research`, `ask_user_question`

### Environment Variables

Create a `.env` in the swarm project root:

```bash
# Web search (optional)
TAVILY_API_KEY=tvly-...

# HuggingFace token (for benchmark datasets)
HF_TOKEN=hf_...

# Override default model
OLLAMA_MODEL=nemotron-3-super:cloud
```

## Models

Works with any Ollama model. Cloud models recommended for best results:

| Model | Notes |
|-------|-------|
| `nemotron-3-super:cloud` | Default, good balance |
| `qwen3.5:397b-cloud` | Strong reasoning |
| `gemma4:31b-cloud` | Fast, good code |
| `deepseek-v3.2:cloud` | Large context |
| `gemma4:e4b` | Local, small, fast |

```bash
swarm model list          # See all available models
swarm model select        # Interactive picker
swarm model set qwen3.5:397b-cloud
```

## Tech Stack

- **Runtime:** Node.js 18+ (TypeScript, ESM)
- **LLM:** Ollama (local + cloud models, OpenAI-compatible API)
- **Search:** Tavily API
- **CLI:** Commander.js + custom terminal UI
- **Build:** tsup

## Project Structure

```
swarm/
├── src/
│   ├── index.ts              # Entry point
│   ├── agents/
│   │   ├── base.ts           # BaseAgent abstract class
│   │   └── llm-agent.ts      # LLM agent with streaming + tool calling
│   ├── cli/
│   │   ├── index.ts           # Command registration
│   │   ├── tui.ts             # Interactive terminal UI
│   │   ├── model-picker.ts    # Model selection UI
│   │   ├── stream-renderer.ts # Streaming output
│   │   ├── tps-display.ts     # Tokens/second display
│   │   └── commands/
│   │       ├── init.ts        # swarm init
│   │       ├── run.ts         # swarm run
│   │       ├── fix.ts         # swarm fix
│   │       ├── chat.ts        # swarm chat
│   │       ├── status.ts      # swarm status
│   │       ├── model.ts       # swarm model
│   │       └── ollama.ts      # swarm ollama
│   ├── core/
│   │   ├── orchestrator.ts    # Pipeline: plan → execute → summary
│   │   ├── architect.ts       # Architect/planner agent
│   │   ├── validation.ts      # Zod schema validation for task plans
│   │   ├── session.ts         # Session persistence
│   │   └── types.ts           # Core types
│   ├── config/
│   │   └── config.ts          # Config load/save
│   ├── providers/
│   │   ├── ollama.ts          # Ollama provider
│   │   ├── openai.ts          # OpenAI provider
│   │   └── factory.ts         # Provider factory
│   ├── tools/
│   │   ├── registry.ts        # Tool registry
│   │   ├── sandbox.ts         # Directory sandbox
│   │   ├── files.ts           # read/write/edit/list files
│   │   ├── shell.ts           # run_command
│   │   ├── web-search.ts      # Tavily search
│   │   ├── user-input.ts      # ask_user_question
│   │   └── research.ts        # Research delegation
│   └── utils/
│       ├── logger.ts          # CLI output
│       └── timeout.ts         # Timeout utilities
├── AGENT.md                   # Agent architecture docs
├── .env.example               # Environment template
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## License

MIT
