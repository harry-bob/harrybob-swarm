# src/utils/

## What This Directory Contains

Shared utility functions used across the codebase.

## Key Files

| File | Purpose |
|------|---------|
| `logger.ts` | `log()`, `logSuccess()`, `logInfo()`, `logWarning()` — chalk-colored console output |
| `timeout.ts` | `withTimeout()` — wraps promises with a timeout |

## Known Flaws

- **Logger writes to stdout**: Should use stderr for info/debug to keep stdout clean for piping
- **`withTimeout` doesn't clean up**: If the wrapped promise is still running after timeout, it continues in the background
- **No log levels**: No way to enable verbose/debug logging — it's all-or-nothing
