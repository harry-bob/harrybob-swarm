import { LLMAgent } from "../agents/llm-agent.js";
import { AgentResult } from "../agents/base.js";
import { ArchitectAgent } from "./architect.js";
import { TaskPlan, Subtask } from "./types.js";
import { createProvider } from "../providers/factory.js";
import { Sandbox, ToolRegistry, createReadFileTool, createWriteFileTool, createEditFileTool, createListFilesTool, createRunCommandTool, createAskUserQuestionTool, createWebSearchTool, createResearchTool } from "../tools/index.js";
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

// ── Tool registries (with sandbox) ──────────────────────────────

function createCoderTools(sandbox: Sandbox): ToolRegistry {
  const r = new ToolRegistry();
  r.register(createReadFileTool(sandbox));
  r.register(createWriteFileTool(sandbox));
  r.register(createEditFileTool(sandbox));
  r.register(createListFilesTool(sandbox));
  r.register(createRunCommandTool(sandbox));
  r.register(createWebSearchTool());
  return r;
}

function createReviewerTools(sandbox: Sandbox): ToolRegistry {
  const r = new ToolRegistry();
  r.register(createReadFileTool(sandbox));
  r.register(createListFilesTool(sandbox));
  r.register(createRunCommandTool(sandbox));
  return r;
}

function createArchitectTools(sandbox: Sandbox, provider: any, model: string): ToolRegistry {
  const r = new ToolRegistry();
  r.register(createReadFileTool(sandbox));
  r.register(createListFilesTool(sandbox));
  r.register(createAskUserQuestionTool());
  r.register(createWebSearchTool());
  r.register(createResearchTool(provider, model, sandbox));
  return r;
}

// ── Tool instruction prompts ────────────────────────────────────

const CODER_TOOLS_PROMPT = `

You have tools: list_files, read_file, write_file, edit_file, run_command, web_search.

⚠️ IMPORTANT: You MUST use tools to complete the task. Do NOT just describe what you would do — actually create files, run commands, and verify your work.
- Use write_file to create files
- Use edit_file to modify existing files
- Use read_file to read existing code
- Use run_command to test your code
- Use web_search to look up documentation
- Use list_files to explore the project

You are NOT done until you have used tools to create/modify files and verified they work. A response without tool calls is not acceptable.
All file operations are restricted to the project directory.`;

const REVIEWER_TOOLS_PROMPT = `\n\nYou have read-only tools: list_files, read_file, run_command.
Inspect code and run tests. Do NOT write or edit files — provide feedback for the coder.
End your review with EXACTLY one line: [STATUS: APPROVED] — if code is good or [STATUS: NEEDS_WORK] — if it needs improvements.`;


// ── UI helpers ──────────────────────────────────────────────────

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
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

// ── Orchestrator ─────────────────────────────────────────────────

export class Orchestrator {
  private config: SwarmConfig;
  private provider;
  private sandbox: Sandbox;

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

    // ── Phase 1: Planning (Leader) ───────────────────────────
    console.log(chalk.magenta(`${"─".repeat(60)}`));
    console.log(chalk.magenta.bold("🧠 PHASE 1: PLANNING"));
    console.log(chalk.magenta(`${"─".repeat(60)}`));

    const architectTools = createArchitectTools(this.sandbox, this.provider, this.config.model);
    const architect = new ArchitectAgent(this.provider, this.config.model, architectTools);
    const plan = await architect.plan(taskDescription);

    console.log(chalk.magenta(`\n  🎯 ${plan.goal}`));
    console.log(chalk.magenta(`  📦 ${plan.subtasks.length} subtask(s)\n`));

    for (const st of plan.subtasks) {
      const deps = st.dependencies.length > 0 ? chalk.gray(` → after ${st.dependencies.join(", ")}`) : "";
      console.log(chalk.magenta(`  ┌─ ${chalk.bold(st.id)}: ${st.title}${deps}`));
      const desc = st.description.length > 100 ? st.description.slice(0, 100) + "..." : st.description;
      console.log(chalk.magenta(`  └─ ${chalk.dim(desc)}`));
      console.log();
    }

    // ── Phase 2: Execute ──────────────────────────────────────
    console.log(chalk.blue(`${"─".repeat(60)}`));
    console.log(chalk.blue.bold("⚡ PHASE 2: EXECUTION"));
    console.log(chalk.blue(`${"─".repeat(60)}`));

    const subtaskResults = await this.executeSubtasks(plan);

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
    console.log(chalk.green(boxLine(`  🤖 Agents: ${[...new Set(allResults.map(r => r.agentRole.split(":")[0]))].join(", ")}`)));

    if (failedIds.length > 0) {
      console.log(chalk.green(boxLine(`  ${chalk.yellow("⚠")}  ${failedIds.length} subtask(s) skipped`)));
    }

    console.log(chalk.green(boxBottom()));
    console.log();

    // ── Save session for follow-up context ──────────────────────
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
    }).catch(() => {}); // non-blocking

    const output = Object.entries(subtaskResults)
      .map(([taskId, results]) => {
        const subtask = plan.subtasks.find((s) => s.id === taskId);
        const body = results.map((r) => r.output).filter(Boolean).join("\n\n");
        return body || `(no output for ${subtask?.title || taskId})`;
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

  private async executeSubtasks(
    plan: TaskPlan
  ): Promise<Record<string, AgentResult[]>> {
    const results: Record<string, AgentResult[]> = {};
    const failed = new Set<string>();
    const completed = new Set<string>();

    while (completed.size + failed.size < plan.subtasks.length) {
      const ready = plan.subtasks.filter(
        (st) =>
          !completed.has(st.id) &&
          !failed.has(st.id) &&
          st.dependencies.every((dep) => completed.has(dep)) &&
          !st.dependencies.some((dep) => failed.has(dep))
      );

      if (ready.length === 0) {
        const blocked = plan.subtasks.filter(
          (st) => !completed.has(st.id) && !failed.has(st.id)
        );
        for (const st of blocked) {
          console.log(chalk.yellow(`  ⏭  Skipping [${st.id}] — dependency failed`));
          failed.add(st.id);
        }
        if (blocked.length === 0) {
          console.log(chalk.red("  ⚠ No ready subtasks — possible circular dependency."));
        }
        break;
      }

      const ids = ready.map(s => s.id).join(", ");
      const emoji = ready.length > 1 ? "⚡" : "▶";
      console.log(chalk.blue(`\n  ${emoji} Running: ${ids}`));

      const tasksWithContext = ready.map((st) => {
        const depContext = st.dependencies
          .map((dep) => {
            const depResults = results[dep] || [];
            const depSubtask = plan.subtasks.find((s) => s.id === dep);
            const outputs = depResults.map((r) => `[${r.agentRole}]\n${r.output}`).join("\n");
            return `### ${depSubtask?.title || dep}\n${outputs}`;
          })
          .join("\n\n");

        return { subtask: st, context: depContext };
      });

      const settled = await Promise.allSettled(
        tasksWithContext.map(({ subtask, context }) =>
          this.runWorkerPair(subtask, context)
        )
      );

      for (let i = 0; i < ready.length; i++) {
        const result = settled[i];
        if (result.status === "fulfilled") {
          results[ready[i].id] = result.value;
          completed.add(ready[i].id);
        } else {
          failed.add(ready[i].id);
          const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
          console.log(chalk.red(`  ❌ [${ready[i].id}] failed: ${reason}`));
        }
      }
    }

    return results;
  }

  private async runWorkerPair(
    subtask: Subtask,
    depContext: string
  ): Promise<AgentResult[]> {
    const allResults: AgentResult[] = [];
    const coderConfig = this.config.agents.coder;
    const reviewerConfig = this.config.agents.reviewer;

    const coder = new LLMAgent(
      {
        role: `coder:${subtask.id}`,
        systemPrompt: coderConfig.systemPrompt + CODER_TOOLS_PROMPT,
      },
      this.config.model,
      this.provider,
      createCoderTools(this.sandbox)
    );

    const reviewer = new LLMAgent(
      {
        role: `reviewer:${subtask.id}`,
        systemPrompt: reviewerConfig.systemPrompt + REVIEWER_TOOLS_PROMPT,
      },
      this.config.model,
      this.provider,
      createReviewerTools(this.sandbox)
    );

    let iteration = 0;
    let lastCode = "";

    while (true) {
      iteration++;

      console.log(chalk.gray(`\n  ┌─── ${subtask.title} ─── iter ${iteration}`));

      // ── Coder ──
      let coderMessage: string;
      if (iteration === 1) {
        const ctx = depContext ? `\n\nContext from prior subtasks:\n${depContext}` : "";
        coderMessage = `Task: ${subtask.description}${ctx}`;
      } else {
        const lastReview = allResults[allResults.length - 1].output;
        coderMessage = `Task: ${subtask.description}\n\nYour previous code:\n${lastCode}\n\nReviewer feedback:\n${lastReview}\n\nImprove your code based on the feedback. Use tools to read/edit files.`;
      }

      console.log(chalk.blue(`  │ 🛠  Coder`));

      let coderResult: AgentResult;
      try {
        coderResult = await coder.execute({
          id: `task-${Date.now()}-coder-${subtask.id}-${iteration}`,
          description: subtask.description,
          messages: [{ role: "user", content: coderMessage }],
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`  │ ❌ Coder failed: ${msg}`));
        break;
      }

      allResults.push(coderResult);
      lastCode = coderResult.output;

      // ── Reviewer ──
      const reviewMessage = `Task: ${subtask.description}\n\nCode has been written. Use tools to read files and inspect the code, then review it.\n\nEnd with exactly one line:\n[STATUS: APPROVED] — if code is good\n[STATUS: NEEDS_WORK] — if it needs improvements`;

      console.log(chalk.blue(`  │ 🔍 Reviewer`));

      let reviewResult: AgentResult;
      try {
        reviewResult = await reviewer.execute({
          id: `task-${Date.now()}-reviewer-${subtask.id}-${iteration}`,
          description: subtask.description,
          messages: [{ role: "user", content: reviewMessage }],
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`  │ ❌ Reviewer failed: ${msg}`));
        break;
      }

      allResults.push(reviewResult);

      if (reviewResult.output.includes("[STATUS: NEEDS_WORK]")) {
        console.log(chalk.yellow(`  │ 🔄 Needs work — looping`));
      } else {
        console.log(chalk.green(`  └─ ✅ Approved`));
        break;
      }

    }

    return allResults;
  }
}
