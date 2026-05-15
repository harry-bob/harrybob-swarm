# Swarm Agent Architecture

## Overview

Swarm is a multi-agent coding system that decomposes tasks into smaller subtasks and routes them to specialized agents.

```
User Request
     │
     ▼
┌─────────────┐     ┌─────────────┐
│  Leader/    │────▶│  Researcher │
│  Architect  │     │   (tool)    │
└─────────────┘     └─────────────┘
     │
     ▼
┌─────────────┐     ┌─────────────┐
│    Coder    │◀────│ Reviewer 1  │
│             │     ├─────────────┤
│             │◀────│ Reviewer 2  │
└─────────────┘     └─────────────┘
     │                    ▲
     └────────────────────┘
   loop until 2/2 consensus
```

## Roles

| Role | File | Purpose |
|------|------|---------|
| **Leader** | `src/core/architect.ts` | Decomposes tasks into a dependency-aware `TaskPlan` with Zod validation |
| **Researcher** | `src/tools/research.ts` | Gathers context for the Leader via `web_search` and file reads |
| **Coder** | `src/agents/llm-agent.ts` | Implements subtasks; writes and edits files |
| **Reviewer** | `src/agents/llm-agent.ts` | Validates code for bugs, security, and performance (consensus voting) |

## Communication Flow

1. **Leader** analyzes the codebase and produces a validated `TaskPlan` with subtasks, dependencies, and optional verification commands.
2. **Coder** receives a subtask description plus outputs from any dependencies.
3. **Stubborn Retry**: If the Coder finishes without touching any files (`write_file`, `edit_file`, or `run_command`), the Orchestrator re-prompts with stronger instructions up to **5 retries**.
4. **Reviewer Consensus**: Two reviewers inspect the code in parallel. Both must return `[STATUS: APPROVED]` for consensus. If one rejects, the Coder receives both reviews with a note about which reviewer to prioritize.
5. **Verification Gate**: If the subtask has a `verification` command (e.g., `npm test`), it runs after consensus. If it fails, the Coder gets one auto-fix attempt.
6. If rejected at any gate, the Coder receives the feedback and retries. Max **3 review rounds** before forced acceptance.

## Tool Assignment

| Tool | Leader | Coder | Reviewer | Researcher |
|------|:------:|:-----:|:--------:|:----------:|
| `read_file` | ✅ | ✅ | ✅ | ✅ |
| `write_file` | ❌ | ✅ | ❌ | ❌ |
| `edit_file` | ❌ | ✅ | ❌ | ❌ |
| `list_files` | ✅ | ✅ | ✅ | ✅ |
| `run_command` | ❌ | ✅ | read-only | ❌ |
| `web_search` | ✅* | ✅* | ❌ | ✅ |
| `research` | ✅* | ❌ | ❌ | ❌ |
| `ask_user_question` | ✅* | ❌ | ❌ | ❌ |

\* Disabled when listed in `config.disabledTools`.

## Plan Validation

Architect plans are validated with **Zod** (`src/core/validation.ts`). Invalid plans log specific schema errors and fall back to a single-subtask plan.

## Rate-Limit Considerations

Each task consumes multiple LLM calls:

- Architect: 1 call
- Coder: 1+ calls (implementation + stubborn retries + verification fixes)
- Reviewer: 2 calls per round (consensus voting)
- Researcher: 1 call per query

With multiple parallel workers and dual reviewers, this can exhaust cloud API quotas quickly.

## Release & Deployment Rules

**DO NOT auto-push to GitHub or npm.**

- After making code changes, **commit locally** but do **not** `git push` unless the user explicitly asks.
- After bumping the version, **do not** `npm publish` unless the user explicitly says to.
- Ask the user for confirmation before any push or publish step.
