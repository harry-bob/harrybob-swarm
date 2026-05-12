# Orchestration Agents

## Orchestrator (`orchestrator.ts`)

Manages the full agent pipeline.

### Agent Creation

```typescript
createCoderTools(sandbox, config)     → ToolRegistry
createReviewerTools(sandbox)          → ToolRegistry
createArchitectTools(sandbox, ..., config) → ToolRegistry
```

Tools are filtered by `config.disabledTools` via `isToolDisabled()`.

### Worker Pair

```
runWorkerPair(subtask, depContext)
  │
  ├─ iteration 1:
  │   ├─ Coder: "Task: {description}"
  │   └─ Reviewer: "Review code, end with [STATUS: ...]"
  │
  ├─ if NEEDS_WORK:
  │   ├─ iteration 2:
  │   │   ├─ Coder: "Your previous code + reviewer feedback"
  │   │   └─ Reviewer: re-review
  │   └─ ... until APPROVED (no max)
  │
  └─ return AgentResult[]
```

### Stubborn Retry (in orchestrator)

If `coderResult.hasModifiedFiles === false` after the first iteration:
- Log warning: "Coder did not modify any files"
- Re-prompt the coder with stronger instructions
- Up to 5 retries before giving up

## ArchitectAgent (`architect.ts`)

Specialized agent that creates the task plan.

### Plan Output

```typescript
interface TaskPlan {
  goal: string;
  subtasks: Subtask[];
}

interface Subtask {
  id: string;          // "task-1"
  title: string;       // "Implement auth module"
  description: string; // detailed instructions
  dependencies: string[]; // ["task-0"]
}
```

### Planning Flow

1. Read all files in the project directory
2. Analyze the task description
3. Decompose into subtasks with dependency graph
4. Return TaskPlan
