# src/config/

## What This Directory Contains

Configuration management: loading, saving, and typing the `.swarmrc.json` config file.

## Key Files

| File | Purpose |
|------|---------|
| `config.ts` | `loadConfig()`, `saveConfig()`, config type definition |

## Config Schema (.swarmrc.json)

```typescript
{
  version: string;
  provider: "ollama" | "openai";
  model: string;
  baseURL: string;
  agents: {
    researcher: { role: string; systemPrompt: string };
    coder: { role: string; systemPrompt: string };
    reviewer: { role: string; systemPrompt: string };
  };
  orchestration: {
    maxConcurrentAgents: number;
    timeout: number;  // 0 = no limit
  };
  disabledTools?: string[];  // e.g. ["web_search", "research", "ask_user_question"]
}
```

## Known Flaws

- **No schema validation**: If `.swarmrc.json` is malformed, errors are cryptic
- **No merge with defaults**: If a field is missing, it's just `undefined` — no fallback
- **`disabledTools` added later**: Older configs won't have this field; code handles it with `|| []` but it's not documented in the schema
- **Per-directory only**: Config is always in CWD, no way to use a global config
