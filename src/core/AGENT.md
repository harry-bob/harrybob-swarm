# Orchestration Agents

## Orchestrator (`orchestrator.ts`)

Central controller that manages the full agent pipeline.

### Tool Factory Methods

```typescript
createCoderTools(sandbox, config)         → ToolRegistry
createReviewerTools(sandbox)              → ToolRegistry
createArchitectTools(sandbox, ..., config) → ToolRegistry
```

Tools are filtered by `config.disabledTools` via `isToolDisabled()`.

### Pipeline Execution

```
processSubtaskPipeline(subtask)
│
├─ Coder implements the subtask (with full conversation continuity)
├─ Stubborn Retry: up to 5 times if no files were modified
│
└─ Reviewer Consensus Loop (max 3 rounds):
    ├─ Run Reviewer 1 and Reviewer 2 in parallel
    ├─ Require both to return [STATUS: APPROVED]
    ├─ If consensus fails:
    │   └─ Coder receives combined feedback with priority notes
    └─ If consensus passes:
        └─ Proceed to verification gate
```

### Verification Gate

If the subtask defines a `verification` command (e.g., `npm test -- src/foo.test.ts`):

1. Run the command after reviewer consensus.
2. If it exits non-zero, log failure and give the Coder **1 auto-fix attempt**.
3. If the fix still fails, accept the subtask with a warning.

This enforces that code not only passes review but also passes tests/builds.

### Stubborn Retry

If `coder.hasModifiedFiles() === false` after the first pass:
1. Log warning.
2. Re-prompt the Coder with stronger instructions.
3. Repeat up to **5 times** before surrendering.

## ArchitectAgent (`architect.ts`)

Specialized agent that produces the initial `TaskPlan`.

### Plan Format

```typescript
interface TaskPlan {
  goal: string;
  subtasks: Subtask[];
}

interface Subtask {
  id: string;               // "task-1"
  title: string;            // "Implement auth module"
  description: string;      // Detailed instructions
  dependencies: string[];   // ["task-0"]
  verification?: string;  // Optional: "npm test -- src/auth.test.ts"
}
```

### Plan Validation

Plans are validated with **Zod** (`src/core/validation.ts`):

- `goal` must be non-empty.
- `subtasks` must be a non-empty array.
- Each subtask must have non-empty `id`, `title`, and `description`.

If validation fails, specific schema errors are logged and the plan falls back to a single-subtask plan.

### Planning Flow

1. Read project files via tools.
2. Analyze the user request.
3. Decompose into subtasks with an explicit dependency graph.
4. Validate and return a `TaskPlan`.

### Re-planning

After each subtask completes, the Architect may adjust remaining subtasks based on completed work. Re-planning is best-effort — failures do not halt the pipeline.
