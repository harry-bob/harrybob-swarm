# Tool Definitions

## Tool Interface

```typescript
interface Tool {
  definition: {
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string }>;
  };
  execute(args: Record<string, any>): Promise<string>;
}
```

## ToolRegistry (`registry.ts`)

```typescript
class ToolRegistry {
  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  has(name: string): boolean;
  getDefinitions(): ToolDefinition[]; // For LLM function-calling schema
  execute(name, args): Promise<string>;
}
```

## Sandbox (`sandbox.ts`)

All file-path operations are validated against the project root.

```
Sandbox(rootDir)
├─ validate(path) → throws if outside root
├─ getRoot() → returns root directory
├─ isAllowed(path) → boolean
└─ relative(path) → relative path from root
```

Security checks:
- Resolves to absolute path.
- Verifies prefix match with root directory.
- Blocks `../` traversal.
- Blocks absolute paths outside root.

## Tool Matrix

| Tool | Architect | Coder | Reviewer | Researcher |
|------|:---------:|:-----:|:--------:|:----------:|
| `read_file` | ✅ | ✅ | ✅ | ✅ |
| `write_file` | ❌ | ✅ | ❌ | ❌ |
| `edit_file` | ❌ | ✅ | ❌ | ❌ |
| `list_files` | ✅ | ✅ | ✅ | ✅ |
| `run_command` | ❌ | ✅ | read-only | ❌ |
| `web_search` | ✅* | ✅* | ❌ | ✅ |
| `research` | ✅* | ❌ | ❌ | ❌ |
| `ask_user_question` | ✅* | ❌ | ❌ | ❌ |

\* Disabled when present in `config.disabledTools`.

## Disabling Tools

The `disabledTools` array in `.swarmrc.json` prevents registration entirely:

- `web_search` — blocks internet access
- `research` — disables the Researcher agent
- `ask_user_question` — removes interactive prompts (required for headless benchmark runners)

## File Cache (`files.ts`)

A per-subtask cache for `read_file` results, invalidated on `write_file` and `edit_file`.
