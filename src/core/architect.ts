import { LLMProvider, ChatMessage } from "../providers/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { TaskPlan, Subtask } from "./types.js";
import { TaskPlanSchema } from "./validation.js";
import chalk from "chalk";

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 10_000;
const MAX_INVESTIGATE_ROUNDS = 20;
const MAX_REPLAN_ROUNDS = 15;
const MAX_NO_TOOL_NUDGES = 2; // abort loop if model refuses to call tools

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= MAX_RETRIES) break;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.yellow(`[architect] ⚠ ${label} failed (attempt ${attempt}/${MAX_RETRIES}): ${msg.slice(0, 120)}`));
      console.log(chalk.gray(`[architect]    Retrying in ${RETRY_DELAY_MS / 1000}s...`));
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  throw lastErr;
}

// ── Phase 1: Investigation ──────────────────────────────────

const INVESTIGATOR_SYSTEM_PROMPT = `You are an expert software architect investigating a codebase before planning any changes.

## Your Mission
Gather enough context about the project structure, existing code, and relevant technologies so that a subsequent planning step can produce a precise, actionable task breakdown.

## Tools
- read_file — read file contents
- list_files — list files and directories
- run_command — execute shell commands (e.g., "cat package.json", "git log --oneline -5")
- web_search — search the web for documentation or best practices
- research — delegate to a research agent for deep investigation
- ask_user_question — ask the user for clarification (only if the request is truly ambiguous)

## Investigation Protocol (MUST follow)
1. DISCOVER STRUCTURE: Start with list_files on the project root. Identify the tech stack (package.json, tsconfig.json, Cargo.toml, pyproject.toml, etc.).
2. READ KEY FILES: Read configuration files, entry points, and any files likely related to the task.
3. MAP DEPENDENCIES: Understand which files import from which. Identify the module graph.
4. GAP ANALYSIS: Determine what already exists vs. what needs to be built. Note existing patterns (error handling, naming conventions, testing style).
5. EXTERNAL KNOWLEDGE: If the task involves unfamiliar libraries or APIs, use web_search or research to gather context.
6. CLARIFY: Only use ask_user_question if the task has genuinely ambiguous requirements after investigation. NEVER use it for technical issues like file read errors — use run_command("cat <path>") as a fallback instead.

## Efficiency Rules
- Do NOT call the same tool with the same arguments more than once. Previous tool results are in the conversation history. Repeating a tool call wastes tokens and is never necessary.
- After listing a directory, read the specific files you need — do not re-list the same directory.
- After reading a file, do not read it again unless you suspect it changed.
- If you feel the urge to call list_files(path: ".") again, STOP — the result is already in the history above.

## Output Format
After your investigation, produce a structured REPORT with these sections:
- PROJECT_SUMMARY: Tech stack, key directories, entry points
- RELEVANT_FILES: List of files read and their relevance to the task
- EXISTING_PATTERNS: Code style, error handling, testing approach
- GAPS: What is missing and must be built
- RISKS: Potential blockers or complexity points
- RECOMMENDATIONS: Suggested approach and key design decisions

Do NOT produce a task plan yet. Focus purely on understanding and reporting.`;

// ── Phase 3: Completion Report ───────────────────────────

const REPORTER_SYSTEM_PROMPT = `You are an expert software architect writing a post-run completion report.

## Your Mission
Investigate what was actually built/changed during this task, then produce a clear summary + usage guide.

## Tools
- read_file — read file contents
- list_files — list files and directories
- run_command — execute shell commands (e.g., "cat package.json", "ls -la src/")

## Investigation Protocol
1. Use list_files on the project root to understand the current state.
2. Read the most relevant files that were likely created or modified (focus on entry points, configs, new modules).
3. Run commands if needed to understand how to use the result (e.g., "cat README.md", "node --version").
4. Keep it focused — 3-6 tool calls is enough.

## Efficiency Rules
- Do NOT call the same tool twice with the same arguments.
- Do NOT ask the user any questions.

## Output Format
After investigating, write a completion report in markdown with EXACTLY these sections:

### What Was Accomplished
2-4 bullet points describing what was built or changed. Be specific about files and functionality.

### Files Created / Modified
Group by "New files:" and "Modified files:" with a one-line description of each.

### How to Use It
Concrete usage instructions. Include:
- Exact commands to run
- Any required configuration or environment variables
- The main entry point or interface

### What's Left (if anything)
Any skipped subtasks or obvious follow-up work. Omit this section if everything completed.

Keep the report practical. No filler text.`;

// ── Phase 2: Planning ─────────────────────────────────────

const PLANNER_SYSTEM_PROMPT = `You are an expert software architect creating precise, actionable task plans.

## Context
You have already investigated the codebase. You will receive:
1. The user's original request
2. A detailed investigation report about the codebase

Your job is to produce a JSON task plan that breaks the work into independent, parallelizable subtasks.

## Planning Rules (STRICT)
1. BREAK IT DOWN: 
   - Simple tasks (≤1 file, ≤50 lines): 1 subtask is OK.
   - Medium tasks: 2-4 subtasks.
   - Complex tasks (new feature, API, refactor): 3-6 subtasks.
   - NEVER forward the raw user request as a single vague subtask.

2. BE SPECIFIC:
   - Each description must name EXACT files to create/modify.
   - Each description must name EXACT functions, classes, or variables.
   - Each description must specify expected behavior, inputs, and outputs.
   - Include a "filesExpected" array listing files the subtask will touch.

3. ORDER LOGICALLY:
   - Subtasks execute in the order listed, one after another — there are no parallel tracks.
   - Put foundational pieces first (types, utilities, schemas) before the code that uses them.
   - Use ids like "task-1", "task-2", "task-3".

4. VERIFICATION:
   - Every subtask SHOULD have a "verification" command (test, build, lint, run).
   - Verification must be specific: "npm test -- src/foo.test.ts", not "run tests".

5. COMPLEXITY ESTIMATION:
   - Tag each subtask with estimatedComplexity: "low", "medium", or "high".

## Output Format — ONLY JSON
Respond with ONLY a valid JSON object. No markdown fences, no preamble, no commentary.

{
  "goal": "Brief summary of the overall goal",
  "rationale": "Explain WHY you chose this breakdown and ordering",
  "subtasks": [
    {
      "id": "task-1",
      "title": "Short title",
      "description": "Detailed description with exact file names, function names, and requirements. A developer should be able to implement this without asking questions.",
      "verification": "npm test -- src/foo.test.ts",
      "filesExpected": ["src/foo.ts", "src/foo.test.ts"],
      "estimatedComplexity": "medium"
    }
  ]
}`;

// ── Phase 3: Validation feedback ────────────────────────────

const PLAN_FIX_PROMPT = `The task plan you produced has validation errors. Fix them and return ONLY the corrected JSON.

Errors:`;

// ── Phase 4: Replanning with investigation ────────────────

const REPLANNER_SYSTEM_PROMPT = `You are an expert software architect reviewing progress and adjusting plans.

## Context
You previously planned a multi-step task. Some subtasks are now complete.
You have received reviewer feedback on the completed work.
Your job is to determine if the remaining plan still makes sense, or if it needs adjustment.

## Tools
- read_file — read file contents to see what was actually built
- list_files — list files and directories to verify structure
- run_command — execute shell commands (e.g., "cat package.json", "npm test")
- web_search — search the web for documentation
- ask_user_question — ask the user for clarification

## Investigation Protocol
1. VERIFY COMPLETED WORK: Read the files that were supposed to be created/modified by completed subtasks. Check if they actually exist and contain what was expected.
2. CHECK DEVIATIONS: Compare what was built vs. what you planned. Note any deviations, missing pieces, or unexpected additions.
3. REVIEW REVIEWER FEEDBACK: Consider the reviewers' findings — bugs they found, gaps they noted, design issues they raised.
4. ASSESS REMAINING PLAN: Look at the remaining subtasks. Are they still valid? Do they need to change based on what was actually built?
5. DECIDE: If the remaining plan is good as-is, say "NO CHANGES".
   If changes are needed, produce updated remaining subtasks.

## Handling Read Errors
If read_file returns an ENOENT or similar error for a file that appears in list_files:
- Try run_command("cat <path>") as a fallback — this often succeeds when read_file has a transient issue.
- If that also fails, rely on the reviewer feedback to understand what was built.
- NEVER ask the user about filesystem errors or whether to proceed — just make the best decision you can from the available information.

## Efficiency Rules
- Do NOT call the same tool with the same arguments more than once. Repeating a tool call wastes tokens and is never necessary.
- After listing a directory, read the specific files you need — do not re-list the same directory.
- After reading a file, do not read it again unless you suspect it changed.
- If you feel the urge to call list_files(path: ".") again, STOP — the result is already in the history above.

## Output Format
After your investigation, respond with ONE of:
1. "NO CHANGES" — if the remaining plan is fine as-is.
2. A JSON object with updated remaining subtasks:
{
  "goal": "same overall goal",
  "rationale": "why changes were needed based on investigation and reviewer feedback",
  "subtasks": [
    {
      "id": "task-3",
      "title": "...",
      "description": "...",
      "verification": "...",
      "filesExpected": ["src/foo.ts"],
      "estimatedComplexity": "medium"
    }
  ]
}`;

export class ArchitectAgent {
  private provider: LLMProvider;
  private model: string;
  private tools: ToolRegistry;
  private projectDir: string;
  private toolCache = new Map<string, string>();
  private readonly CACHEABLE_TOOLS = new Set(["read_file", "list_files", "web_search"]);
  private totalTokens = { prompt: 0, completion: 0, reasoning: 0 };

  constructor(provider: LLMProvider, model: string, tools: ToolRegistry, projectDir?: string) {
    this.provider = provider;
    this.model = model;
    this.tools = tools;
    this.projectDir = projectDir || process.cwd();
  }

  getTokenUsage(): { prompt: number; completion: number; reasoning: number } {
    return { ...this.totalTokens };
  }

  private async chat(...args: Parameters<LLMProvider['chat']>): Promise<import('../providers/types.js').ChatResponse> {
    const response = await this.provider.chat(...args);
    this.totalTokens.prompt += response.usage?.prompt || 0;
    this.totalTokens.completion += response.usage?.completion || 0;
    this.totalTokens.reasoning += response.usage?.reasoning || 0;
    return response;
  }

  // ═══════════════════════════════════════════════════════════
  //  Main entry point
  // ═══════════════════════════════════════════════════════════

  async plan(taskDescription: string): Promise<TaskPlan> {
    console.log(chalk.magenta("\n🧠 Architect analyzing task..."));

    // Phase 1: Investigate the codebase
    const investigation = await this.investigate(taskDescription);

    // Phase 2: Produce a task plan based on investigation
    let plan = await this.createPlan(taskDescription, investigation);

    // Phase 3: Validate and refine
    plan = this.validatePlan(plan, taskDescription);

    // If validation found issues, try to fix once
    const issues = this.auditPlan(plan);
    if (issues.length > 0) {
      console.log(chalk.yellow(`[architect] ⚠ Plan audit found ${issues.length} issue(s). Requesting fix...`));
      plan = await this.fixPlan(plan, taskDescription, investigation, issues);
      plan = this.validatePlan(plan, taskDescription);
    }

    return plan;
  }

  async replanWithInvestigation(
    taskDescription: string,
    plan: TaskPlan,
    completedIds: string[],
    results: Record<string, { agentRole: string; output: string }[]>,
    reviewerFeedbacks: Array<{ report: string; source: string; reviewStatus: string }>
  ): Promise<TaskPlan | null> {
    console.log(chalk.magenta("\n🧠 Architect replanning after subtask completion..."));

    const completed = plan.subtasks.filter((s) => completedIds.includes(s.id));
    const remaining = plan.subtasks.filter((s) => !completedIds.includes(s.id));

    if (remaining.length === 0) return null;

    // Build context prompt
    const completedSummary = completed
      .map((s) => {
        const res = results[s.id] || [];
        const lastOutput = res[res.length - 1]?.output || "(no output)";
        const preview = lastOutput.slice(0, 400);
        return `### ${s.id}: ${s.title}\n${preview}...`;
      })
      .join("\n\n");

    const remainingSummary = remaining
      .map((s) => `- ${s.id}: ${s.title} — ${s.description}`)
      .join("\n");

    const feedbackBlock = reviewerFeedbacks
      .map(
        (fb) =>
          `REVIEWER: ${fb.source}\nSTATUS: ${fb.reviewStatus}\nREPORT:\n${fb.report}\n`
      )
      .join("\n---\n");

    const prompt = `ORIGINAL TASK:\n${taskDescription}\n\nOVERALL GOAL: ${plan.goal}\n\nCOMPLETED SUBTASKS:\n${completedSummary}\n\n${feedbackBlock}\n\nREMAINING SUBTASKS (current plan):\n${remainingSummary}\n\nInvestigate the current state of the project. Read files created by completed subtasks. Assess whether the remaining plan still makes sense. Respond with "NO CHANGES" or an updated JSON plan for remaining subtasks.`;

    const messages: ChatMessage[] = [
      { role: "system", content: REPLANNER_SYSTEM_PROMPT },
      { role: "system", content: `Current project directory: ${this.projectDir}` },
      { role: "user", content: prompt },
    ];

    const toolDefs = this.tools.getDefinitions();
    let rounds = 0;
    let hasUsedTool = false;
    let nudgeCount = 0;

    while (rounds < MAX_REPLAN_ROUNDS) {
      rounds++;

      const progressSummary = this.summarizeInvestigationProgress(messages);
      if (progressSummary) {
        messages.push({ role: "system", content: progressSummary });
      }

      const response = await withRetry(
        () =>
          this.chat({
            model: this.model,
            messages,
            tools: toolDefs,
          }),
        "replan-investigate"
      );

      if (response.tool_calls && response.tool_calls.length > 0) {
        hasUsedTool = true;
        messages.push({
          role: "assistant",
          content: response.content || "",
          tool_calls: response.tool_calls,
          thinking: response.thinking,
        });

        for (const toolCall of response.tool_calls) {
          const argsStr = Object.entries(toolCall.arguments)
            .map(([k, v]) => `${k}: "${String(v).slice(0, 60)}${String(v).length > 60 ? "..." : ""}"`)
            .join(", ");
          console.log(chalk.magenta(`[architect] ⚙ ${toolCall.name}(${argsStr})`));

          const cacheKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
          let output: string;

          if (this.CACHEABLE_TOOLS.has(toolCall.name) && this.toolCache.has(cacheKey)) {
            output = this.toolCache.get(cacheKey)!;
            console.log(chalk.magenta(`[architect] ⚙ ${toolCall.name}(${argsStr}) ${chalk.gray("[cached]")}`));
          } else {
            try {
              output = await this.tools.execute(toolCall.name, toolCall.arguments);
            } catch (err: unknown) {
              output = `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
            if (this.CACHEABLE_TOOLS.has(toolCall.name)) {
              this.toolCache.set(cacheKey, output);
            }
          }

          messages.push({
            role: "user",
            content: `Tool "${toolCall.name}" result:\n${output}`,
          });
        }
        continue;
      }

      if (!hasUsedTool) {
        nudgeCount++;
        if (nudgeCount > MAX_NO_TOOL_NUDGES) {
          console.log(chalk.yellow(`[architect] ⚠ Model not calling tools after ${nudgeCount} nudges — proceeding without investigation`));
          return null;
        }
        messages.push({
          role: "user",
          content: `Before you can decide, you MUST use tools to investigate the current state. Please use list_files and read_file to check what was actually built. Do not respond without first exploring the project.`,
        });
        continue;
      }

      const content = response.content || "NO CHANGES";
      console.log(chalk.magenta(`[architect] ✅ Replanning investigation complete (${rounds} round${rounds > 1 ? "s" : ""})`));

      if (content.includes("NO CHANGES")) {
        console.log(chalk.magenta(`  ⏭  Architect: no changes needed`));
        return null;
      }

      // Try to parse JSON plan
      return this.parseRemainingPlan(content, plan, completedIds);
    }

    console.log(chalk.yellow(`[architect] ⚠ Hit max replan rounds (${MAX_REPLAN_ROUNDS}), keeping original plan`));
    return null;
  }

  private parseRemainingPlan(content: string, originalPlan: TaskPlan, completedIds: string[]): TaskPlan | null {
    try {
      let jsonStr = content.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }

      const parsed = JSON.parse(jsonStr);
      const validated = TaskPlanSchema.parse(parsed);

      const newSubtasks: Subtask[] = validated.subtasks.map((st, i) => ({
        id: st.id || `task-${i + 1}`,
        title: st.title || `Task ${i + 1}`,
        description: st.description || st.title || "",
        dependencies: st.dependencies || [],
        verification: st.verification,
        filesExpected: st.filesExpected,
        estimatedComplexity: st.estimatedComplexity,
      }));

      // Validate: no completed IDs in new subtasks
      const duplicates = newSubtasks.filter((s) => completedIds.includes(s.id));
      if (duplicates.length > 0) {
        console.log(chalk.yellow(`[architect] ⚠ Replan tried to overwrite completed subtask(s): ${duplicates.map((d) => d.id).join(", ")} — filtering out`));
      }

      const validNew = newSubtasks.filter((s) => !completedIds.includes(s.id));
      const keptSubtasks = originalPlan.subtasks.filter((s) => completedIds.includes(s.id));

      if (validNew.length === 0) return null;

      return {
        goal: validated.goal || originalPlan.goal,
        rationale: validated.rationale || originalPlan.rationale,
        subtasks: [...keptSubtasks, ...validNew],
      };
    } catch (err) {
      if (err && typeof err === "object" && "issues" in err) {
        const issues = (err as any).issues.map((e: any) => `${e.path.join(".")}: ${e.message}`).join(", ");
        console.log(chalk.yellow(`[architect] ⚠ Replan parse/validation failed: ${issues}`));
      } else {
        console.log(chalk.yellow(`[architect] ⚠ Could not parse replan response — keeping original plan`));
      }
      return null;
    }
  }

  async replan(prompt: string): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ];

    const response = await withRetry(() => this.provider.chat({
      model: this.model,
      messages,
      responseFormat: { type: "json_object" },
    }), "replan");

    return response.content || "NO CHANGES";
  }

  // ═══════════════════════════════════════════════════════════
  //  Completion Report
  // ═══════════════════════════════════════════════════════════

  async generateReport(
    taskDescription: string,
    plan: TaskPlan,
    completedIds: string[],
    allOutput: string,
  ): Promise<string> {
    console.log(chalk.magenta("[architect] 📝 Generating completion report..."));

    const completedSubtasks = plan.subtasks.filter((s) => completedIds.includes(s.id));
    const failedSubtasks = plan.subtasks.filter((s) => !completedIds.includes(s.id));

    const context = [
      `## Original Task\n${taskDescription}`,
      `## Plan Goal\n${plan.goal}`,
      `## Subtasks Completed\n${completedSubtasks.map((s) => `- ${s.id}: ${s.title}`).join("\n") || "(none)"}`,
      failedSubtasks.length > 0
        ? `## Subtasks Skipped\n${failedSubtasks.map((s) => `- ${s.id}: ${s.title}`).join("\n")}`
        : "",
    ].filter(Boolean).join("\n\n");

    const messages: ChatMessage[] = [
      { role: "system", content: REPORTER_SYSTEM_PROMPT },
      { role: "system", content: `Current project directory: ${this.projectDir}` },
      {
        role: "user",
        content: `${context}\n\nInvestigate the project to see what was actually built, then write the completion report.`,
      },
    ];

    const toolDefs = this.tools.getDefinitions().filter((t) =>
      ["read_file", "list_files", "run_command"].includes(t.name)
    );

    const MAX_REPORT_ROUNDS = 8;
    let rounds = 0;
    let hasUsedTool = false;

    while (rounds < MAX_REPORT_ROUNDS) {
      rounds++;

      const response = await withRetry(() => this.chat({
        model: this.model,
        messages,
        tools: toolDefs,
      }), "report");

      if (response.tool_calls && response.tool_calls.length > 0) {
        hasUsedTool = true;
        messages.push({
          role: "assistant",
          content: response.content || "",
          tool_calls: response.tool_calls,
          thinking: response.thinking,
        });

        for (const toolCall of response.tool_calls) {
          const argsStr = Object.entries(toolCall.arguments)
            .map(([k, v]) => `${k}: "${String(v).slice(0, 60)}${String(v).length > 60 ? "..." : ""}"`)
            .join(", ");

          const cacheKey = `report:${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
          let output: string;

          if (this.toolCache.has(cacheKey)) {
            output = this.toolCache.get(cacheKey)!;
            console.log(chalk.magenta(`[architect] ⚙ ${toolCall.name}(${argsStr}) ${chalk.gray("[cached]")}`));
          } else {
            console.log(chalk.magenta(`[architect] ⚙ ${toolCall.name}(${argsStr})`));
            try {
              output = await this.tools.execute(toolCall.name, toolCall.arguments);
            } catch (err: unknown) {
              output = `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
            this.toolCache.set(cacheKey, output);
          }

          messages.push({
            role: "user",
            content: `Tool "${toolCall.name}" result:\n${output}`,
          });
        }
        continue;
      }

      // No tool calls — nudge once to investigate first
      if (!hasUsedTool) {
        messages.push({
          role: "user",
          content: `Please investigate the project first using list_files and read_file before writing the report.`,
        });
        continue;
      }

      // Report is ready
      return response.content || "(report generation failed — no response)";
    }

    // Hit round limit — fall back to last assistant message
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    return last?.content || "(report generation failed — hit round limit)";
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase 1: Investigation
  // ═══════════════════════════════════════════════════════════

  private async investigate(taskDescription: string): Promise<string> {
    console.log(chalk.magenta("[architect] 🔍 Investigating codebase..."));

    const messages: ChatMessage[] = [
      { role: "system", content: INVESTIGATOR_SYSTEM_PROMPT },
      { role: "system", content: `Current project directory: ${this.projectDir}` },
      { role: "user", content: `The user wants: "${taskDescription}"\n\nInvestigate the project to understand what exists and what needs to change. Use your tools.` },
    ];

    const toolDefs = this.tools.getDefinitions();
    let rounds = 0;
    let hasUsedTool = false;
    let nudgeCount = 0;

    while (rounds < MAX_INVESTIGATE_ROUNDS) {
      rounds++;

      // Inject a progress summary so the model cannot miss what it already did
      const progressSummary = this.summarizeInvestigationProgress(messages);
      if (progressSummary) {
        messages.push({ role: "system", content: progressSummary });
      }

      const response = await withRetry(() => this.provider.chat({
        model: this.model,
        messages,
        tools: toolDefs,
      }), "investigate");

      // If the model wants to use tools
      if (response.tool_calls && response.tool_calls.length > 0) {
        hasUsedTool = true;
        messages.push({
          role: "assistant",
          content: response.content || "",
          tool_calls: response.tool_calls,
          thinking: response.thinking,
        });

        for (const toolCall of response.tool_calls) {
          const argsStr = Object.entries(toolCall.arguments)
            .map(([k, v]) => `${k}: "${String(v).slice(0, 60)}${String(v).length > 60 ? '...' : ''}"`)
            .join(", ");
          console.log(chalk.magenta(`[architect] ⚙ ${toolCall.name}(${argsStr})`));

          const cacheKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
          let output: string;

          if (this.CACHEABLE_TOOLS.has(toolCall.name) && this.toolCache.has(cacheKey)) {
            output = this.toolCache.get(cacheKey)!;
            console.log(chalk.magenta(`[architect] ⚙ ${toolCall.name}(${argsStr}) ${chalk.gray("[cached]")}`));
          } else {
            try {
              output = await this.tools.execute(toolCall.name, toolCall.arguments);
            } catch (err: unknown) {
              output = `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
            if (this.CACHEABLE_TOOLS.has(toolCall.name)) {
              this.toolCache.set(cacheKey, output);
            }
          }

          messages.push({
            role: "user",
            content: `Tool "${toolCall.name}" result:\n${output}`,
          });
        }
        continue;
      }

      // No tool calls — if we haven't used any tools yet, force investigation
      if (!hasUsedTool) {
        nudgeCount++;
        if (nudgeCount > MAX_NO_TOOL_NUDGES) {
          console.log(chalk.yellow(`[architect] ⚠ Model not calling tools after ${nudgeCount} nudges — proceeding with minimal investigation`));
          return response.content || "(investigation skipped — model did not use tools)";
        }
        messages.push({
          role: "user",
          content: `Before you can report, you MUST use tools to investigate the codebase. Please use list_files on the project root and read any relevant configuration or source files. Do not produce a report without first exploring the project.`,
        });
        continue;
      }

      // Investigation complete
      const report = response.content || "(no report generated)";
      console.log(chalk.magenta(`[architect] ✅ Investigation complete (${rounds} round${rounds > 1 ? "s" : ""})`));
      return report;
    }

    // Hit round limit — return what we have
    console.log(chalk.yellow(`[architect] ⚠ Hit max investigation rounds (${MAX_INVESTIGATE_ROUNDS}), proceeding with partial investigation`));
    const last = messages[messages.length - 1];
    return last?.content || "(investigation incomplete)";
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase 2: Planning
  // ═══════════════════════════════════════════════════════════

  private async createPlan(taskDescription: string, investigation: string): Promise<TaskPlan> {
    console.log(chalk.magenta("[architect] 📝 Formulating plan..."));

    const prompt = `USER REQUEST:\n${taskDescription}\n\nINVESTIGATION REPORT:\n${investigation}\n\nNow produce the JSON task plan.`;

    const messages: ChatMessage[] = [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      { role: "system", content: `Current project directory: ${this.projectDir}` },
      { role: "user", content: prompt },
    ];

    return this.chatAndParsePlan(messages, "plan");
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase 3: Validation
  // ═══════════════════════════════════════════════════════════

  private validatePlan(plan: TaskPlan, fallback: string): TaskPlan {
    // Deduplicate and normalize subtask IDs
    const seen = new Set<string>();
    const normalized = plan.subtasks.map((st, i) => {
      let id = st.id || `task-${i + 1}`;
      if (seen.has(id)) {
        id = `task-${i + 1}`;
      }
      seen.add(id);
      return { ...st, id };
    });

    plan.subtasks = normalized;
    return plan;
  }

  private auditPlan(plan: TaskPlan): string[] {
    const issues: string[] = [];

    // Single subtask for complex goals
    if (plan.subtasks.length === 1) {
      const desc = plan.subtasks[0].description;
      const wordCount = desc.split(/\s+/).length;
      if (wordCount > 30 || (plan.subtasks[0].filesExpected && plan.subtasks[0].filesExpected.length > 2)) {
        issues.push("The task appears complex but was broken into only 1 subtask. Break it into smaller, sequential pieces.");
      }
    }

    // Vague descriptions
    for (const st of plan.subtasks) {
      if (!st.description.includes(".") || st.description.split(/\s+/).length < 15) {
        issues.push(`Subtask ${st.id} description is too vague. Must specify exact files, functions, and behavior.`);
      }
      if (!st.filesExpected || st.filesExpected.length === 0) {
        issues.push(`Subtask ${st.id} is missing filesExpected. List the files it will create or modify.`);
      }
    }

    // Missing verifications
    const missingVerif = plan.subtasks.filter((s) => !s.verification).length;
    if (missingVerif === plan.subtasks.length) {
      issues.push("No subtasks have verification commands. Add specific test/build/run commands to prove correctness.");
    }

    return issues;
  }

  private async fixPlan(plan: TaskPlan, taskDescription: string, investigation: string, issues: string[]): Promise<TaskPlan> {
    const prompt = `USER REQUEST:\n${taskDescription}\n\nINVESTIGATION REPORT:\n${investigation}\n\nCURRENT PLAN (with errors):\n${JSON.stringify(plan, null, 2)}\n\n${PLAN_FIX_PROMPT}\n${issues.map((i) => `- ${i}`).join("\n")}\n\nReturn ONLY the corrected JSON object.`;

    const messages: ChatMessage[] = [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      { role: "system", content: `Current project directory: ${this.projectDir}` },
      { role: "user", content: prompt },
    ];

    return this.chatAndParsePlan(messages, "fix-plan");
  }

  // ═══════════════════════════════════════════════════════════
  //  Utilities
  // ═══════════════════════════════════════════════════════════

  private async chatAndParsePlan(
    messages: ChatMessage[],
    label: string
  ): Promise<TaskPlan> {
    let attempts = 0;
    const maxParseAttempts = 3;
    let lastError = "";

    while (attempts < maxParseAttempts) {
      attempts++;
      const response = await withRetry(
        () =>
          this.chat({
            model: this.model,
            messages,
            responseFormat: { type: "json_object" },
          }),
        label
      );

      const content = response.content || "";

      try {
        return this.parsePlan(content);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = msg;
        console.log(
          chalk.yellow(
            `[architect] ⚠ Plan parse/validation failed (attempt ${attempts}/${maxParseAttempts}): ${msg.slice(0, 120)}`
          )
        );

        if (attempts >= maxParseAttempts) break;

        // Re-engage architect with error details
        messages.push({ role: "assistant", content });
        messages.push({
          role: "user",
          content: `Your response could not be parsed as a valid task plan.\n\nErrors:\n${msg}\n\nPlease fix the errors and return ONLY a corrected JSON object matching the required schema. Do not include markdown fences, preamble, or commentary.`,
        });
      }
    }

    throw new Error(`Failed to parse plan after ${maxParseAttempts} attempts. Last error: ${lastError}`);
  }

  private parsePlan(content: string): TaskPlan {
    let jsonStr = content.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr);
    const validated = TaskPlanSchema.parse(parsed);

    const subtasks: Subtask[] = validated.subtasks.map((st, i) => ({
      id: st.id || `task-${i + 1}`,
      title: st.title || `Task ${i + 1}`,
      description: st.description || st.title || "",
      dependencies: st.dependencies || [],
      verification: st.verification,
      filesExpected: st.filesExpected,
      estimatedComplexity: st.estimatedComplexity,
    }));

    return {
      goal: validated.goal,
      rationale: validated.rationale,
      subtasks,
    };
  }

  /**
   * Summarize prior tool calls in the investigation conversation so the model
   * cannot miss them.  Produces a short system message listing each tool call
   * with a truncated result preview.
   */
  private summarizeInvestigationProgress(messages: ChatMessage[]): string | null {
    const calls: { name: string; args: string; preview: string }[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          // Look for the matching user result message (usually the next one or soon after)
          let result = "";
          for (let j = i + 1; j < messages.length && j < i + 6; j++) {
            const candidate = messages[j];
            if (
              candidate.role === "user" &&
              candidate.content.startsWith(`Tool "${tc.name}" result:`)
            ) {
              result = candidate.content.slice(`Tool "${tc.name}" result:\n`.length);
              break;
            }
          }

          const argsStr = Object.entries(tc.arguments)
            .map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 40)}`)
            .join(", ");

          const preview = result.slice(0, 120).replace(/\n/g, " ") + (result.length > 120 ? "..." : "");
          calls.push({ name: tc.name, args: argsStr, preview });
        }
      }
    }

    if (calls.length === 0) return null;

    const lines = calls.map((c) => `  • ${c.name}(${c.args}) → ${c.preview}`);
    return `[State] Tools already used this investigation — do NOT repeat any of these:\n${lines.join("\n")}`;
  }
}
