# src/tools/

## What This Directory Contains

Tool implementations that agents can call: file operations, shell commands, web search, research delegation, and user input.

## Key Files

| File | Purpose |
|------|---------|
| `types.ts` | `Tool`, `ToolDefinition`, `ToolResult` interfaces |
| `registry.ts` | `ToolRegistry` — stores and looks up tools by name |
| `index.ts` | Creates all tools, re-exports |
| `sandbox.ts` | `Sandbox` — validates paths against project directory |
| `files.ts` | `read_file`, `write_file`, `edit_file`, `list_files` |
| `shell.ts` | `run_command` — executes shell commands |
| `web-search.ts` | `web_search` — Tavily API search |
| `research.ts` | `research` — spawns researcher agent |
| `user-input.ts` | `ask_user_question` — interactive prompt |

## Tool List

| Tool | Agent Access | Description |
|------|-------------|-------------|
| `read_file` | coder, reviewer, architect | Read file contents |
| `write_file` | coder only | Create/overwrite file |
| `edit_file` | coder only | Exact text replacement in file |
| `list_files` | coder, reviewer, architect | List directory contents |
| `run_command` | coder, reviewer | Execute shell command |
| `web_search` | coder, architect (conditional) | Tavily web search |
| `research` | architect (conditional) | Spawns researcher agent |
| `ask_user_question` | architect (conditional) | Interactive prompt |

## Sandbox

All file tools validate paths against the project directory (cwd at startup):
- Path traversal blocked (`../`)
- Absolute paths outside project blocked
- `run_command` cwd locked to project directory

## Known Flaws

- **`edit_file` requires exact text match**: No fuzzy matching — if the text has whitespace differences, the edit fails silently
- **`run_command` has no output limit**: Previously had 5K char limit, now removed — very long outputs can flood context
- **`web_search` uses Tavily API**: Requires `TAVILY_API_KEY` in `.env` — no fallback if key is missing
- **`research` spawns a full agent**: Creates a new LLMAgent for each research query — expensive in tokens
- **`ask_user_question` reads from stdin**: Hangs when stdin is /dev/null or a pipe (fixed by `disabledTools` + `stdin=subprocess.DEVNULL` in benchmark runner)
- **No tool for testing code**: Agents must use `run_command` to run tests — no dedicated `test` tool
- **`edit_file` can't handle overlapping edits**: Must provide unique, non-overlapping oldText regions
- **No `search_files` (grep) tool**: Agents must use `run_command` with `grep` or `find` — not ideal for sandboxed environments
