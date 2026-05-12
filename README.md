# 🐝 Swarm

A CLI multi-agent orchestration tool that uses LLM-powered agents to decompose tasks, write code, and review it — powered by Ollama.

## Features

- 🧠 **Architect Agent** — Analyzes tasks, asks clarifying questions, creates execution plans
- 🛠 **Coder Agent** — Writes code using file tools (read, write, edit, run commands)
- 🔍 **Reviewer Agent** — Reviews code for bugs, security, and best practices
- ⚡ **Parallel Execution** — Independent subtasks run simultaneously
- 🔄 **Feedback Loops** — Reviewer kicks back code until it's approved (no round limits)
- 🌐 **Web Search** — Tavily API integration for research
- 🔒 **Sandbox** — Agents are restricted to the project directory
- 💭 **Streaming** — Real-time token streaming with thinking/reasoning display
- 🎯 **Interactive Mode** — Chat-like terminal UI (`swarm chat`)
- 🔧 **Fix Command** — Report bugs and have them fixed using previous context
- 📊 **Disabled Tools** — Configurable per-project tool restrictions

## Architecture

```
User Request
      ↓
🧠 Architect — analyzes task, asks questions if needed, creates plan
      ↓
📋 Plan — subtasks with dependency graph
      ↓
⚡ Execute — coder + reviewer pairs run in parallel
  ┌─────┬─────┬─────┐
  C→R   C→R   C→R   ← reviewer kicks back until approved
  └─────┴─────┴─────┘
      ↓
✅ Done — session saved for future context
```

## Installation

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/swarm.git
cd swarm

# Install dependencies
npm install

# Build
npm run build

# Link globally (makes `swarm` available everywhere)
npm link
```

## Prerequisites

### Ollama

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model
ollama pull nemotron-3-super:cloud
```

### Tavily API Key (optional, for web search)

```bash
cp .env.example .env
# Edit .env and add your Tavily API key
```

### HuggingFace Token (optional, for benchmark access)

```bash
# Add to .env
HF_TOKEN=your_token_here
```

## Usage

### Initialize a project

```bash
cd your-project
swarm init
```

This creates `.swarmrc.json` with your model and config.

### Run a task

```bash
swarm run "Create a Python Flask API with user authentication"
```

The architect plans the task, then coder + reviewer pairs execute subtasks in parallel. The reviewer kicks back code until it's approved — no round limits.

### Fix a bug (uses previous context)

```bash
swarm fix "the login endpoint returns 500 when password is empty"
```

Loads the previous session's plan and files for context.

### Interactive mode

```bash
swarm chat
```

```
╔══════════════════════════════════════════════════════════╗
║  🐝 SWARM — Interactive Mode                           ║
╠══════════════════════════════════════════════════════════╣
║  Type a task to create something                        ║
║  fix <issue>     — fix a bug from the previous task     ║
║  model select    — pick a model interactively           ║
║  status          — show swarm configuration             ║
║  exit            — exit interactive mode                ║
╚══════════════════════════════════════════════════════════╝

> create a REST API for todo list
  [architect] 📦 3 subtask(s)
  [coder:task-1] ⚙ write_file(path: "app.py")
  [reviewer:task-1] ✅ Approved
```

### Model management

```bash
swarm model select        # Interactive picker
swarm model show          # Show current model
swarm model set llama3.1  # Set model directly
swarm model list          # List available Ollama models
```

## Commands

| Command | Description |
|---------|-------------|
| `swarm init` | Initialize `.swarmrc.json` in current directory |
| `swarm run <task>` | Run a task through the full pipeline |
| `swarm fix <issue>` | Fix a bug using previous context |
| `swarm chat` | Interactive chat mode |
| `swarm model select` | Pick a model interactively |
| `swarm model set <name>` | Set model directly |
| `swarm model show` | Show current model |
| `swarm model list` | List available models |
| `swarm status` | Show configuration and last session |
| `swarm ollama list` | List Ollama models |

## Configuration

`.swarmrc.json` is created per-project by `swarm init`:

```json
{
  "version": "1.0.0",
  "provider": "ollama",
  "model": "nemotron-3-super:cloud",
  "baseURL": "http://localhost:11434",
  "agents": { ... },
  "orchestration": {
    "maxConcurrentAgents": 3,
    "timeout": 0
  },
  "disabledTools": []
}
```

### Disabling Tools

Restrict tools per-project:

```json
{
  "disabledTools": ["web_search", "research", "ask_user_question"]
}
```

## Tech Stack

- **Runtime:** Node.js 18+ (TypeScript, ESM)
- **LLM:** Ollama (local + cloud models)
- **Search:** Tavily API
- **CLI:** Commander.js + custom TUI
- **Build:** tsup

## Project Structure

```
swarm/
├── src/
│   ├── index.ts              # Entry point (dotenv, CLI bootstrap)
│   ├── agents/
│   │   ├── base.ts           # BaseAgent abstract class
│   │   └── llm-agent.ts      # LLMAgent with streaming + tool calling
│   ├── cli/
│   │   ├── index.ts           # Commander.js command registration
│   │   ├── tui.ts             # Interactive terminal UI
│   │   ├── model-picker.ts    # Interactive model selection
│   │   ├── stream-renderer.ts # Streaming output renderer
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
│   │   ├── orchestrator.ts    # Main orchestrator pipeline
│   │   ├── architect.ts       # Architect/planner agent
│   │   ├── session.ts         # Session persistence
│   │   └── types.ts           # Core types
│   ├── config/
│   │   └── config.ts          # Config load/save
│   ├── providers/
│   │   ├── types.ts           # Provider interface
│   │   ├── stream-types.ts    # Stream chunk types
│   │   ├── factory.ts         # Provider factory
│   │   ├── ollama.ts          # Ollama provider
│   │   └── openai.ts          # OpenAI provider
│   ├── tools/
│   │   ├── types.ts           # Tool interface
│   │   ├── registry.ts        # Tool registry
│   │   ├── sandbox.ts         # Directory sandbox
│   │   ├── files.ts           # read_file, write_file, edit_file, list_files
│   │   ├── shell.ts           # run_command
│   │   ├── web-search.ts      # Tavily web search
│   │   ├── user-input.ts      # ask_user_question
│   │   └── research.ts        # Research tool
│   └── utils/
│       ├── logger.ts          # Colored CLI output
│       └── timeout.ts         # Timeout utilities
├── AGENT.md                   # Agent architecture docs
├── .env.example               # Environment template
├── .gitignore
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## License

MIT
