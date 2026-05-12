# src/core/

## What This Directory Contains

The core orchestration engine: task planning, subtask execution, and session management.

## Key Files

| File | Purpose |
|------|---------|
| `orchestrator.ts` | `Orchestrator` — runs the full pipeline: plan → execute → summary |
| `architect.ts` | `ArchitectAgent` — Leader that decomposes tasks into subtasks |
| `session.ts` | `saveSession()`, `loadSession()` — persists last run for `swarm fix` |
| `types.ts` | `TaskPlan`, `Subtask`, `TaskDependency` type definitions |

## Flow

```
Orchestrator.run(taskDescription)
  │
  ├─ Phase 1: PLANNING
  │   ArchitectAgent.plan(task) → TaskPlan { goal, subtasks[] }
  │   Each subtask has: id, title, description, dependencies
  │
  ├─ Phase 2: EXECUTION
  │   executeSubtasks(plan)
  │     ├─ Find ready subtasks (dependencies satisfied)
  │     ├─ Run all ready subtasks via Promise.allSettled
  │     │   └─ runWorkerPair(subtask, depContext)
  │     │       ├─ Coder agent executes (with tools)
  │     │       └─ Reviewer agent reviews
  │     │       └─ Loop until approved (no max iterations)
  │     └─ Repeat until all done or blocked
  │
  └─ Phase 3: SUMMARY
      Print results, save session
```

## Tool Creation (in orchestrator.ts)

```
createCoderTools(sandbox, config) → read_file, write_file, edit_file, list_files, run_command, [web_search]
createReviewerTools(sandbox)     → read_file, list_files, run_command
createArchitectTools(sandbox, provider, model, config) → read_file, list_files, ask_user_question, [web_search], [research]
```

Tools marked with `[]` are conditionally registered based on `config.disabledTools`.

## Known Flaws

- **No parallel subtask execution within a phase**: `Promise.allSettled` runs all ready subtasks, but each subtask is sequential (coder → reviewer → coder → reviewer...)
- **Reviewer doesn't write code**: If reviewer approves but the code is subtly wrong, there's no second opinion
- **No timeout on individual agents**: Only the top-level orchestrator has a timeout (set to 0 = unlimited)
- **`hasModifiedFiles` only tracks write operations**: read_file doesn't count as "work done" — this is intentional for stubborn retry but can be confusing
- **Session only stores last run**: No history, no diff between runs
- **The coder's stubborn retry mechanism is in orchestrator.ts**: If the coder doesn't modify any files, the orchestrator re-prompts up to 5 times. This is hardcoded, not configurable.
- **`disabledTools` filtering**: Each tool creation function checks `isToolDisabled()` — if you add a new tool, you must remember to add the check
- **No dependency parallelism**: If subtask B and C both depend on A, they run sequentially after A completes. They could run in parallel.
