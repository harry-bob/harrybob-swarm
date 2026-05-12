import { LLMAgent } from "../agents/llm-agent.js";
import { AgentResult } from "../agents/base.js";
import { ArchitectAgent } from "./architect.js";
import { TaskPlan, Subtask } from "./types.js";
import { createProvider } from "../providers/factory.js";
import { Sandbox, ToolRegistry, FileCache, createReadFileTool, createWriteFileTool, createEditFileTool, createListFilesTool, createRunCommandTool, createAskUserQuestionTool, createWebSearchTool, createResearchTool } from "../tools/index.js";
import { saveSession } from "./session.js";
import chalk from "chalk";

interface SwarmConfig {
  version: string;
  provider: string;
  model: string;
  agents: Record<string, { role: string; systemPrompt: string }>;
  orchestration: {
    maxConcurrentAgents: number;
    timeout: number;
  };
  disabledTools?: string[];
}

interface RunOptions {
  agents?: string[];
  verbose?: boolean;
}

interface RunResult {
  output: string;
  duration: number;
  agentsUsed: string[];
  iterations: number;
  tokenUsage: { prompt: number; completion: number };
  plan?: TaskPlan;
}

// ── Tool registries (with sandbox + cache) ────────────────────

function isToolDisabled(name: string, config: SwarmConfig): boolean {
  return (config.disabledTools || []).includes(name);
}

function createCoderTools(sandbox: Sandbox, config: SwarmConfig, cache?: FileCache): ToolRegistry {
  const r = new ToolRegistry();
  r.register(createReadFileTool(sandbox, cache));
  r.register(createWriteFileTool(sandbox, cache));
  r.register(createEditFileTool(sandbox, cache));
  r.register(createListFilesTool(sandbox));
  r.register(createRunCommandTool(sandbox));
  if (!isToolDisabled("web_search", config)) r.register(createWebSearchTool());
  return r;
}

function createReviewerTools(sandbox: Sandbox): ToolRegistry {
  const r = new ToolRegistry();
  r.register(createReadFileTool(sandbox));
  r.register(createListFilesTool(sandbox));
  r.register(createRunCommandTool(sandbox));
  return r;
}

function createArchitectTools(sandbox: Sandbox, provider: any, model: string, config: SwarmConfig): ToolRegistry {
  const r = new ToolRegistry();
  r.register(createReadFileTool(sandbox));
  r.register(createListFilesTool(sandbox));
  if (!isToolDisabled("ask_user_question", config)) r.register(createAskUserQuestionTool());
  if (!isToolDisabled("web_search", config)) r.register(createWebSearchTool());
  // TEMPORARILY DISABLED — to re-enable, uncomment the line below
  // if (!isToolDisabled("research", config)) r.register(createResearchTool(provider, model, sandbox));
  return r;
}

// ── Tool instruction prompts ──────────────────────────────────

const CODER_TOOLS_PROMPT = `

You have tools: list_files, read_file, write_file, edit_file, run_command, web_search.

⚠️ IMPORTANT: You MUST use tools to complete the task. Do NOT just describe what you would do — actually create files, run commands, and verify your work.
- Use write_file to create files
- Use edit_file to modify existing files
- Use read_file to read existing code
- Use run_command to test your code (default 30s timeout, pass timeout param for longer)
- Use web_search to look up documentation
- Use list_files to explore the project

You are NOT done until you have used tools to create/modify files and verified they work. A response without tool calls is not acceptable.
All file operations are restricted to the project directory.`;

const REVIEWER_TOOLS_PROMPT = `\n\nYou have read-only tools: list_files, read_file, run_command.
Inspect code and run tests. Do NOT write or edit files — provide feedback for the coder.
End your review with EXACTLY one line: [STATUS: APPROVED] — if code is good or [STATUS: NEEDS_WORK] — if it needs improvements.`;


// ── Semaphore for concurrency control ─────────────────────────

class Semaphore {
  private waiting: (() => void)[] = [];
  private count: number;

  constructor(max: number) {
    this.count = max;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    if (this.waiting.length > 0) {
      this.waiting.shift()!();
    } else {
      this.count++;
    }
  }
}

// ── UI helpers ────────────────────────────────────────────────

const BOX = {
  tl: "╔", tr: "╗", bl: "╚", br: "╝",
  h: "═", v: "║",
  ml: "╠", mr: "╣",
};

function boxLine(text: string, width = 60): string {
  const padding = Math.max(0, width - text.length - 2);
  return `${BOX.v} ${text}${" ".repeat(padding)}${BOX.v}`;
}

function boxTop(width = 60): string {
  return BOX.tl + BOX.h.repeat(width) + BOX.tr;
}

function boxBottom(width = 60): string {
  return BOX.bl + BOX.h.repeat(width) + BOX.br;
}

function boxSep(width = 60): string {
  return BOX.ml + BOX.h.repeat(width) + BOX.mr;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) % 60);
  return `${mins}m ${secs}s`;
}

// ── Orchestrator ──────────────────────────────────────────────

export class Orchestrator {
  private config: SwarmConfig;
  private provider;
  private sandbox: Sandbox;
  private maxReviewerRounds = 3;

  constructor(config: SwarmConfig) {
    this.config = config;
    this.provider = createProvider(config.provider, config.model);
    this.sandbox = new Sandbox(process.cwd());
  }

  async run(taskDescription: string, options: RunOptions = {}): Promise<RunResult> {
    const startTime = Date.now();

    // ── Banner ────────────────────────────────────────────────
    console.log();
    console.log(chalk.cyan(boxTop()));
    console.log(chalk.cyan(boxLine(chalk.bold("🐝 SWARM") + chalk.gray(` v${this.config.version || "0.1.0"}`))));
    console.log(chalk.cyan(boxSep()));
    console.log(chalk.cyan(boxLine(`${chalk.white("Model:")}  ${this.config.model}`)));
    console.log(chalk.cyan(boxLine(`${chalk.white("Dir:")}    ${this.sandbox.getRoot()}`)));
    console.log(chalk.cyan(boxBottom()));
    console.log();

    // ── Phase 1: Planning (Architect) ────────────────────────
    console.log(chalk.magenta(`${"─".repeat(60)}`));
    console.log(chalk.magenta.bold("🧠 PHASE 1: PLANNING"));
    console.log(chalk.magenta(`${"─".repeat(60)}`));

    const architectTools = createArchitectTools(this.sandbox, this.provider, this.config.model, this.config);
    const architect = new ArchitectAgent(this.provider, this.config.model, architectTools);
    const plan = await architect.plan(taskDescription);

    this.printPlan(plan);

    // ── Phase 2: Pipeline Execution ──────────────────────────
    console.log(chalk.blue(`${"─".repeat(60)}`));
    console.log(chalk.blue.bold("⚡ PHASE 2: EXECUTION"));
    console.log(chalk.blue(`${"─".repeat(60)}`));

    const subtaskResults = await this.executePipeline(taskDescription, plan, architect, architectTools);

    // ── Phase 3: Summary ──────────────────────────────────────
    const duration = Date.now() - startTime;
    const allResults = Object.values(subtaskResults).flat();

    const totalTokens = allResults.reduce(
      (acc, r) => ({
        prompt: acc.prompt + r.tokenUsage.prompt,
        completion: acc.completion + r.tokenUsage.completion,
      }),
      { prompt: 0, completion: 0 }
    );

    const completedIds = Object.keys(subtaskResults);
    const failedIds = plan.subtasks.filter((s) => !completedIds.includes(s.id));

    this.printSummary(plan, completedIds, failedIds, duration, totalTokens);

    // ── Save session ─────────────────────────────────────────
    const filesCreated = allResults
      .flatMap((r) => {
        const matches = r.output.matchAll(/(?:write_file|File written)[^)]*\(path:\s*"([^"]+)"\)/g);
        return [...matches].map((m) => m[1]);
      });

    await saveSession({
      lastTask: taskDescription,
      lastPlan: plan.goal,
      filesCreated: [...new Set(filesCreated)],
      timestamp: Date.now(),
    }).catch(() => {});

    const output = Object.entries(subtaskResults)
      .map(([taskId, results]) => {
        const body = results.map((r) => r.output).filter(Boolean).join("\n\n");
        return body || `(no output for ${taskId})`;
      })
      .filter(Boolean)
      .join("\n\n");

    return {
      output,
      duration,
      agentsUsed: allResults.map((r) => r.agentRole),
      iterations: 0,
      tokenUsage: totalTokens,
      plan,
    };
  }

  // ── Pipeline Execution ────────────────────────────────────

  /**
   * Pipeline architecture: coders and reviewers run independently.
   * When a coder finishes, it immediately frees its slot for the next task.
   * The reviewer runs concurrently with the next coder.
   * Re-planning happens after each subtask completes.
   */
  private async executePipeline(
    taskDescription: string,
    plan: TaskPlan,
    architect: ArchitectAgent,
    architectTools: ToolRegistry
  ): Promise<Record<string, AgentResult[]>> {
    const results: Record<string, AgentResult[]> = {};
    const completed = new Set<string>();
    const failed = new Set<string>();
    const inProgress = new Set<string>();
    const semaphore = new Semaphore(this.config.orchestration.maxConcurrentAgents);
    const activePromises: Promise<void>[] = [];

    // Track review rounds per subtask (max 3)
    const reviewRounds = new Map<string, number>();

    const getReady = (): Subtask[] =>
      plan.subtasks.filter(
        (st) =>
          !completed.has(st.id) &&
          !failed.has(st.id) &&
          !inProgress.has(st.id) &&
          st.dependencies.every((dep) => completed.has(dep)) &&
          !st.dependencies.some((dep) => failed.has(dep))
      );

    // Seed initial ready tasks
    const spawnReady = () => {
      const ready = getReady();
      for (const subtask of ready) {
        inProgress.add(subtask.id);
        const p = this.processSubtaskPipeline(
          subtask,
          plan,
          results,
          completed,
          failed,
          inProgress,
          semaphore,
          reviewRounds,
          taskDescription,
          architect,
          architectTools,
          spawnReady
        );
        activePromises.push(p);
      }
    };

    spawnReady();

    // Wait for all work to complete
    while (activePromises.length > 0) {
      await Promise.race(activePromises);
      // Remove settled promises
      for (let i = activePromises.length - 1; i >= 0; i--) {
        // Check if promise is settled by trying a race with itself
        const p = activePromises[i];
        const settled = await Promise.race([p.then(() => true), Promise.resolve(false)]);
        if (settled) {
          activePromises.splice(i, 1);
        }
      }
    }

    return results;
  }

  /**
   * Process a single subtask through the coder→reviewer pipeline.
   * Uses conversation continuity — coder keeps its full history across review loops.
   * When done, calls spawnNew() to check for newly ready subtasks.
   */
  private async processSubtaskPipeline(
    subtask: Subtask,
    plan: TaskPlan,
    results: Record<string, AgentResult[]>,
    completed: Set<string>,
    failed: Set<string>,
    inProgress: Set<string>,
    semaphore: Semaphore,
    reviewRounds: Map<string, number>,
    taskDescription: string,
    architect: ArchitectAgent,
    architectTools: ToolRegistry,
    spawnNew: () => void
  ): Promise<void> {
    const cache = new FileCache();
    const coderConfig = this.config.agents.coder;
    const reviewerConfig = this.config.agents.reviewer;

    // Build dependency context
    const depContext = subtask.dependencies
      .map((dep) => {
        const depResults = results[dep] || [];
        const depSubtask = plan.subtasks.find((s) => s.id === dep);
        const outputs = depResults.map((r) => `[${r.agentRole}]\n${r.output}`).join("\n");
        return `### ${depSubtask?.title || dep}\n${outputs}`;
      })
      .join("\n\n");

    const allResults: AgentResult[] = [];

    try {
      await semaphore.acquire();

      console.log(chalk.blue(`\n  ┌─── ${subtask.title} ───`));

      // ── Create coder with conversation continuity ──────────
      const coder = new LLMAgent(
        {
          role: `coder:${subtask.id}`,
          systemPrompt: coderConfig.systemPrompt + CODER_TOOLS_PROMPT,
        },
        this.config.model,
        this.provider,
        createCoderTools(this.sandbox, this.config, cache)
      );

      // Start coder conversation
      const ctx = depContext ? `\n\nContext from prior subtasks:\n${depContext}` : "";
      coder.startTask({
        id: `task-${subtask.id}-coder`,
        description: subtask.description,
        messages: [{ role: "user", content: `Task: ${subtask.description}${ctx}` }],
      });

      // First coder pass
      console.log(chalk.blue(`  │ 🛠  Coder`));
      let iteration = 0;
      let lastCoderOutput = "";

      // Use continueChat for the initial message (empty string since startTask already added it)
      const coderResult = await coder.continueChat(`Begin implementing the task now. Use your tools.`);

      const coderAgentResult: AgentResult = {
        taskId: `coder:${subtask.id}:${iteration}`,
        agentRole: `coder:${subtask.id}`,
        output: coderResult.output,
        tokenUsage: coderResult.tokenUsage,
        duration: 0,
      };
      allResults.push(coderAgentResult);
      lastCoderOutput = coderResult.output;
      iteration++;

      // ── Reviewer loop ──────────────────────────────────────
      const maxRounds = this.maxReviewerRounds;

      while (iteration <= maxRounds) {
        // Release semaphore during review so other tasks can code
        semaphore.release();

        // Create reviewer (fresh each round — read-only, no need for continuity)
        const reviewer = new LLMAgent(
          {
            role: `reviewer:${subtask.id}`,
            systemPrompt: reviewerConfig.systemPrompt + REVIEWER_TOOLS_PROMPT,
          },
          this.config.model,
          this.provider,
          createReviewerTools(this.sandbox)
        );

        console.log(chalk.blue(`  │ 🔍 Reviewer (round ${iteration})`));

        await semaphore.acquire();

        const reviewResult = await reviewer.execute({
          id: `task-${subtask.id}-reviewer-${iteration}`,
          description: subtask.description,
          messages: [{
            role: "user",
            content: `Task: ${subtask.description}\n\nCode has been written. Use tools to read files and inspect the code, then review it.\n\nEnd with exactly one line:\n[STATUS: APPROVED] — if code is good\n[STATUS: NEEDS_WORK] — if it needs improvements`,
          }],
        });

        allResults.push(reviewResult);

        // Check review status
        if (reviewResult.output.includes("[STATUS: APPROVED]") || iteration >= maxRounds) {
          if (iteration >= maxRounds && !reviewResult.output.includes("[STATUS: APPROVED]")) {
            console.log(chalk.yellow(`  └─ ⏰ Max review rounds reached — accepting`));
          } else {
            console.log(chalk.green(`  └─ ✅ Approved`));
          }
          break;
        }

        // ── NEEDS_WORK — continue coder conversation ─────────
        console.log(chalk.yellow(`  │ 🔄 Needs work — sending feedback to coder`));
        reviewRounds.set(subtask.id, (reviewRounds.get(subtask.id) || 0) + 1);

        // Re-acquire for coder (already acquired above via the loop)
        console.log(chalk.blue(`  │ 🛠  Coder (round ${iteration + 1})`));

        const coderFixResult = await coder.continueChat(
          `The reviewer found issues. Here is the review feedback:\n\n${reviewResult.output}\n\nFix the issues and improve the code. Use tools to read/edit files.`
        );

        const fixAgentResult: AgentResult = {
          taskId: `coder:${subtask.id}:${iteration}`,
          agentRole: `coder:${subtask.id}`,
          output: coderFixResult.output,
          tokenUsage: coderFixResult.tokenUsage,
          duration: 0,
        };
        allResults.push(fixAgentResult);
        lastCoderOutput = coderFixResult.output;
        iteration++;
      }

      // Mark done
      results[subtask.id] = allResults;
      completed.add(subtask.id);
      inProgress.delete(subtask.id);

      // Release semaphore
      semaphore.release();

      // ── Re-plan: ask architect if remaining plan needs adjustment ──
      if (completed.size < plan.subtasks.length) {
        await this.maybeReplan(taskDescription, plan, completed, results, architect, architectTools);
        // Spawn newly ready subtasks (including any re-planned ones)
        spawnNew();
      }

    } catch (err: unknown) {
      semaphore.release();
      inProgress.delete(subtask.id);
      failed.add(subtask.id);
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`  ❌ [${subtask.id}] failed: ${msg}`));
      // Still spawn new tasks in case some don't depend on this
      spawnNew();
    }
  }

  // ── Re-planning ─────────────────────────────────────────

  /**
   * After a subtask completes, ask the architect if the remaining plan needs adjustment.
   * Only re-plans if there are remaining subtasks.
   */
  private async maybeReplan(
    taskDescription: string,
    plan: TaskPlan,
    completed: Set<string>,
    results: Record<string, AgentResult[]>,
    architect: ArchitectAgent,
    architectTools: ToolRegistry
  ): Promise<void> {
    const remaining = plan.subtasks.filter((s) => !completed.has(s.id));
    if (remaining.length === 0) return;

    // Summarize what's been done
    const completedSummary = plan.subtasks
      .filter((s) => completed.has(s.id))
      .map((s) => {
        const res = results[s.id] || [];
        const lastOutput = res[res.length - 1]?.output || "(no output)";
        const preview = lastOutput.slice(0, 200);
        return `- ${s.title}: ${preview}...`;
      })
      .join("\n");

    const remainingSummary = remaining.map((s) => `- ${s.id}: ${s.title} — ${s.description.slice(0, 100)}`).join("\n");

    // Ask architect (using a quick tool call — not a full planning pass)
    const replanPrompt = `You planned the following task:

Goal: ${plan.goal}

COMPLETED subtasks:
${completedSummary}

REMAINING subtasks:
${remainingSummary}

Based on what was completed, do the remaining subtasks need changes? 
If the remaining plan is fine as-is, respond with "NO CHANGES".
If changes are needed, describe what subtasks to add, modify, or remove. Be specific about which subtask IDs to change.`;

    try {
      const replanResult = await architect.replan(replanPrompt);

      if (replanResult.includes("NO CHANGES")) {
        return;
      }

      // Parse changes (simple heuristic — look for add/remove/modify instructions)
      console.log(chalk.magenta(`\n  🔄 Architect adjusting plan...`));

      // Ask architect to provide updated subtask list
      const updatePrompt = `Based on your analysis, provide the UPDATED remaining subtasks as JSON array. Each subtask has: id, title, description, dependencies (array of subtask IDs).

Current completed subtask IDs: ${[...completed].join(", ")}
New subtasks should NOT duplicate completed ones.

Respond with ONLY a JSON array, no other text:
[{"id": "task-N", "title": "...", "description": "...", "dependencies": ["task-X"]}]`;

      const updateResult = await architect.replan(updatePrompt);

      // Try to parse JSON from the response
      const jsonMatch = updateResult.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const newSubtasks = JSON.parse(jsonMatch[0]) as Subtask[];
          // Validate and merge: keep completed tasks, replace remaining
          const validNew = newSubtasks.filter(
            (s) => !completed.has(s.id) && typeof s.title === "string" && typeof s.description === "string"
          );
          // Preserve completed subtasks, replace remaining with new plan
          const keptSubtasks = plan.subtasks.filter((s) => completed.has(s.id));
          plan.subtasks = [...keptSubtasks, ...validNew];

          console.log(chalk.magenta(`  ✅ Plan updated: ${validNew.length} remaining subtask(s)`));
          for (const s of validNew) {
            console.log(chalk.magenta(`     └─ ${s.id}: ${s.title}`));
          }
        } catch {
          console.log(chalk.gray(`  ⏭  Could not parse updated plan — keeping original`));
        }
      }
    } catch {
      // Re-planning is best-effort — don't fail the whole run
    }
  }

  // ── Display helpers ───────────────────────────────────────

  private printPlan(plan: TaskPlan): void {
    console.log(chalk.magenta(`\n  🎯 ${plan.goal}`));
    console.log(chalk.magenta(`  📦 ${plan.subtasks.length} subtask(s)\n`));
    for (const st of plan.subtasks) {
      const deps = st.dependencies.length > 0 ? chalk.gray(` → after ${st.dependencies.join(", ")}`) : "";
      console.log(chalk.magenta(`  ┌─ ${chalk.bold(st.id)}: ${st.title}${deps}`));
      const desc = st.description.length > 100 ? st.description.slice(0, 100) + "..." : st.description;
      console.log(chalk.magenta(`  └─ ${chalk.dim(desc)}`));
      console.log();
    }
  }

  private printSummary(
    plan: TaskPlan,
    completedIds: string[],
    failedIds: Subtask[],
    duration: number,
    totalTokens: { prompt: number; completion: number }
  ): void {
    console.log();
    console.log(chalk.green(boxTop()));
    console.log(chalk.green(boxLine(chalk.bold("📋 SUMMARY"))));
    console.log(chalk.green(boxSep()));

    for (const st of plan.subtasks) {
      const done = completedIds.includes(st.id);
      const icon = done ? chalk.green("✅") : chalk.red("❌");
      console.log(chalk.green(boxLine(`  ${icon} ${st.id}: ${st.title}`)));
    }

    console.log(chalk.green(boxSep()));
    console.log(chalk.green(boxLine(`  ⏱  Duration: ${formatDuration(duration)}`)));
    console.log(chalk.green(boxLine(`  🔧 Tokens: ${totalTokens.prompt + totalTokens.completion} total`)));

    if (failedIds.length > 0) {
      console.log(chalk.green(boxLine(`  ${chalk.yellow("⚠")}  ${failedIds.length} subtask(s) skipped`)));
    }

    console.log(chalk.green(boxBottom()));
    console.log();
  }
}
