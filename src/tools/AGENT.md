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

## Tool Registry (`registry.ts`)

```typescript
class ToolRegistry {
  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  getAll(): Tool[];
  getDefinitions(): ToolDefinition[]; // for LLM
}
```

## Sandbox (`sandbox.ts`)

All file operations are validated against the project root:

```
Sandbox(rootDir)
  ├─ validatePath(path) → throws if outside root
  └─ getRoot() → returns root directory
```

Path checks:
- Resolves to absolute path
- Checks it starts with root dir
- Blocks `../` traversal
- Blocks absolute paths outside root

## Tool Availability by Agent

| Tool | Architect | Coder | Reviewer | Researcher |
|------|-----------|-------|----------|------------|
| read_file | ✅ | ✅ | ✅ | ✅ |
| write_file | ❌ | ✅ | ❌ | ❌ |
| edit_file | ❌ | ✅ | ❌ | ❌ |
| list_files | ✅ | ✅ | ✅ | ✅ |
| run_command | ❌ | ✅ | ✅ | ❌ |
| web_search | ✅* | ✅* | ❌ | ✅ |
| research | ✅* | ❌ | ❌ | ❌ |
| ask_user | ✅* | ❌ | ❌ | ❌ |

`*` = conditional on `disabledTools` config
