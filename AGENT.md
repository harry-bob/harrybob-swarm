# Agent Architecture

## Overview

Swarm uses a multi-agent system with four specialized roles:

```
User → Leader (Architect) → Researcher (tool)
                          → Coder → Reviewer
                                    ↻ loop until approved
```

## Agent Roles

### Leader (Architect)
- **File**: `src/core/architect.ts`
- **Role**: Decomposes tasks into subtasks with dependencies
- **Tools**: `read_file`, `list_files`, `ask_user_question`, `web_search`, `research`
- **System Prompt**: "You are a software architect. Analyze the task, read existing code, and create a detailed execution plan."
- **Behavior**: Reads codebase first, then creates a `TaskPlan` with subtasks

### Researcher
- **File**: `src/tools/research.ts`
- **Role**: Gathers information for the Leader
- **Tools**: `web_search`, `read_file`, `list_files`
- **System Prompt**: "You are a research agent. Gather information to help the architect plan effectively."
- **Behavior**: Spawned as a tool call from the Leader, returns structured findings

### Coder
- **File**: `src/agents/llm-agent.ts` (generic LLMAgent)
- **Role**: Writes and modifies code
- **Tools**: `read_file`, `write_file`, `edit_file`, `list_files`, `run_command`, `web_search`
- **System Prompt**: "You are an expert software developer. Write clean, efficient, production-ready code."
- **Stubborn Retry**: If coder doesn't modify any files, orchestrator re-prompts up to 5 times

### Reviewer
- **File**: `src/agents/llm-agent.ts` (generic LLMAgent)
- **Role**: Reviews code quality and correctness
- **Tools**: `read_file`, `list_files`, `run_command` (read-only)
- **System Prompt**: "You are a senior code reviewer. Review code for bugs, security, performance."
- **Behavior**: Must end with `[STATUS: APPROVED]` or `[STATUS: NEEDS_WORK]`

## Agent Communication

1. Leader → Coder: task description + dependencies
2. Coder → Reviewer: completed code (via file tools)
3. Reviewer → Coder: feedback (if NEEDS_WORK)
4. Loop until APPROVED

## Disabled Tools

The `disabledTools` config option prevents specific tools from being registered:
- `web_search` — no web access
- `research` — no researcher agent
- `ask_user_question` — no interactive prompts (critical for benchmark runners)

## Token Budget

Each agent makes multiple LLM calls per task:
- Architect: 1 call (plan)
- Coder: 1+ calls (implement + retry)
- Reviewer: 1+ calls (review + re-review)
- Researcher: 1 call per query

With 5 parallel workers, this multiplies rapidly — leading to 429 rate limits on cloud APIs.
