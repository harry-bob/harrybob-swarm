# 🐝 Swarm

A CLI swarm agent developer tool with multi-agent orchestration, powered by Ollama.

Swarm uses a **leader-researcher-coder-reviewer** pipeline to break down tasks, research solutions, write code, and review it — all automatically.

## Features

- 🧠 **Leader Agent** — Analyzes tasks, directs research, creates execution plans
- 🔎 **Researcher Agent** — Searches the web, reads codebases, gathers information
- 🛠 **Coder Agent** — Writes code using file tools (read, write, edit, run)
- 🔍 **Reviewer Agent** — Reviews code for bugs, best practices, and security
- ⚡ **Parallel Execution** — Independent subtasks run simultaneously
- 🔄 **Feedback Loops** — Reviewer kicks back code until it's approved
- 🌐 **Web Search** — Tavily API integration for research
- 🔒 **Sandbox** — Agents can only access the project directory
- 💭 **Streaming** — Real-time token streaming with thinking/reasoning display
- 🎯 **Interactive Mode** — Chat-like terminal UI (`swarm chat`)
- 🔧 **Fix Command** — Report bugs and have them fixed with previous context

## Architecture

```
User Request
      ↓
🧠 Leader — receives task, asks clarification if needed
      ↓
🔎 Research — leader delegates research to researcher (can iterate)
      ↓
📋 Plan — leader creates subtask plan with dependencies
      ↓
⚡ Execute — coder + reviewer pairs run in parallel
  ┌─────┬─────┬─────┐
  C→R   C→R   C→R   ← reviewer can kick back until approved
  └─────┴─────┴─────┘
      ↓
✅ Done
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

# Link globally
npm link
```

## Setup

### 1. Install Ollama

```bash
# macOS / Linux
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model
ollama pull qwen3.5:397b-cloud
```

### 2. Set up Tavily API Key (optional, for web search)

```bash
cp .env.example .env
# Edit .env and add your Tavily API key
```

### 3. Initialize a project

```bash
cd your-project
swarm init
```

## Usage

### Run a task

```bash
swarm run "Create a Python Flask API with user authentication"
```

### Fix a bug (uses previous context)

```bash
swarm fix "the login endpoint returns 500 when password is empty"
```

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
  [leader] 🔎 research(query: "best Python REST API framework")
  [leader] 📦 3 subtask(s)
  [coder:task-1] ⚙ write_file(path: "app.py")
  [reviewer:task-1] ✅ Approved

> fix the POST endpoint doesn't validate empty titles
  [leader] 🔎 research(query: "Flask request validation best practices")
  [coder:task-1] ⚙ edit_file(path: "app.py")
  [reviewer:task-1] ✅ Approved
```

### Model management

```bash
swarm model select        # Interactive picker
swarm model show          # Show current model
swarm model set llama3.1  # Set directly
swarm model list          # List available models
```

### Ollama commands

```bash
swarm ollama list  # List Ollama models
swarm ollama test  # Test connection
```

## Commands

| Command | Description |
|---------|-------------|
| `swarm init` | Initialize swarm config in current directory |
| `swarm run <task>` | Run a task through the full pipeline |
| `swarm fix <issue>` | Fix a bug using previous context |
| `swarm chat` | Interactive chat mode |
| `swarm model select` | Pick a model interactively |
| `swarm model set <name>` | Set model directly |
| `swarm model show` | Show current model |
| `swarm model list` | List available models |
| `swarm status` | Show configuration |
| `swarm ollama list` | List Ollama models |
| `swarm ollama test` | Test Ollama connection |

## Tech Stack

- **Runtime:** Node.js 18+ (TypeScript)
- **LLM:** Ollama (local models, cloud models)
- **Search:** Tavily API
- **CLI:** Commander.js + custom TUI
- **Build:** tsup

## Project Structure

```
swarm/
├── src/
│   ├── index.ts              # Entry point (dotenv, CLI)
│   ├── agents/
│   │   ├── base.ts           # Agent base class
│   │   └── llm-agent.ts      # LLM agent with tool loop + streaming
│   ├── cli/
│   │   ├── index.ts           # CLI command registration
│   │   ├── tui.ts             # Interactive terminal UI
│   │   ├── model-picker.ts    # Model selection
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
│   │   ├── orchestrator.ts    # Main orchestrator (leader → plan → execute)
│   │   ├── architect.ts       # Leader/planner agent
│   │   ├── session.ts         # Session persistence
│   │   └── types.ts           # Core types
│   ├── config/
│   │   └── config.ts          # Config load/save
│   ├── providers/
│   │   ├── types.ts           # Provider interface
│   │   ├── stream-types.ts    # Stream chunk types
│   │   ├── factory.ts         # Provider factory
│   │   ├── ollama.ts          # Ollama provider (streaming + thinking)
│   │   └── openai.ts          # OpenAI provider
│   ├── tools/
│   │   ├── types.ts           # Tool interface
│   │   ├── registry.ts        # Tool registry
│   │   ├── sandbox.ts         # Directory sandbox
│   │   ├── files.ts           # read_file, write_file, edit_file, list_files
│   │   ├── shell.ts           # run_command
│   │   ├── web-search.ts      # Tavily web search
│   │   ├── user-input.ts      # ask_user_question
│   │   └── research.ts        # Research tool (spawns researcher agent)
│   └── utils/
│       ├── logger.ts          # Colored CLI output
│       └── timeout.ts         # Timeout utilities
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## License

MIT
