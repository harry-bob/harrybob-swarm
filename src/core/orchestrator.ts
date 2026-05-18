import { LLMAgent } from "../agents/llm-agent.js";
import { AgentResult } from "../agents/base.js";
import { ArchitectAgent } from "./architect.js";
import { TaskPlan, Subtask } from "./types.js";
import { createProvider } from "../providers/factory.js";
import { Sandbox, ToolRegistry, FileCache, createReadFileTool, createWriteFileTool, createEditFileTool, createListFilesTool, createRunCommandTool, createAskUserQuestionTool, createWebSearchTool, createResearchTool, createReviewerTestTool, createReviewerReturnTool } from "../tools/index.js";
import { saveSession } from "./session.js";
import { getPackageVersion } from "../utils/version.js";
import { RunController } from "./run-controller.js";
import { readdir, rename, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import chalk from "chalk";

interface SwarmConfig {
  version: string;
  provider: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
  numCtx?: number; // Ollama context window size
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
  /** Resume from a previous session — skip planning, reuse this plan */
  resumePlan?: TaskPlan;
  /** IDs of subtasks already completed in a prior run */
  resumeCompleted?: string[];
  /** Enable /status, /skip, /stop slash commands during execution */
  enableRunCommands?: boolean;
}

export interface RunResult {
  output: string;
  duration: number;
  agentsUsed: string[];
  iterations: number;
  tokenUsage: { prompt: number; completion: number; reasoning: number };
  plan?: TaskPlan;
  completed: string[];
  failed: string[];
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

function createReviewerTools(sandbox: Sandbox, taskId: string, reviewerIndex: number): ToolRegistry {
  const r = new ToolRegistry();
  r.register(createReadFileTool(sandbox));
  r.register(createListFilesTool(sandbox));
  r.register(createRunCommandTool(sandbox));
  r.register(createWriteFileTool(sandbox));
  r.register(createReviewerTestTool(sandbox, taskId, reviewerIndex));
  r.register(createReviewerReturnTool());
  return r;
}

function createArchitectTools(sandbox: Sandbox, provider: any, model: string, config: SwarmConfig): ToolRegistry {
  const r = new ToolRegistry();
  r.register(createReadFileTool(sandbox));
  r.register(createListFilesTool(sandbox));
  r.register(createRunCommandTool(sandbox));
  if (!isToolDisabled("ask_user_question", config)) r.register(createAskUserQuestionTool());
  if (!isToolDisabled("web_search", config)) r.register(createWebSearchTool());
  if (!isToolDisabled("research", config)) r.register(createResearchTool(provider, model, sandbox));
  return r;
}

// ── Tool instruction prompts ──────────────────────────────────

const CODER_TOOLS_PROMPT = `

## Your Tools
You have these tools: list_files, read_file, write_file, edit_file, run_command, web_search.

## Core Rules
- You MUST use tools to complete the task. Do NOT just describe what you would do - actually create files, run commands, and verify your work.
- You are NOT done until you have created/modified files AND run verification commands to prove the code works.
- A response without tool calls is not acceptable.
- All file operations are restricted to the project directory.

## Execution Protocol
1. EXPLORE: Use list_files and read_file to understand existing code before making changes.
2. IMPLEMENT: Use write_file for new files, edit_file for modifications. edit_file requires the EXACT old text match.
3. VERIFY: Run tests, build commands, or the code itself to prove correctness. Fix any failures immediately.
4. EDGE CASES: Handle errors, null inputs, and boundary conditions explicitly.
5. NO REPEATS: Do NOT call any tool with the same arguments twice. If you already listed files or read a file, the result is in the history above.

## Tool Usage
- write_file - create new files with complete content
- edit_file - modify existing files (oldText must match exactly)
- read_file - read code before editing
- run_command - test/build/run code (default 30s timeout, pass timeout param for longer)
- web_search - look up documentation or error solutions
- list_files - explore project structure

## Completion Criteria
Before finishing, you MUST run a SELF-REVIEW:
1. Read back any files you created or modified - do they match your intent?
2. Check for bugs: off-by-one errors, null references, unhandled promises, missing imports
3. Check edge cases: empty inputs, invalid data, error paths
4. Verify tests/build/commands pass - if none exist, write a minimal verification script
5. Ensure no TODOs, placeholders, or dead code remain

Only declare the task complete after the self-review passes.

## Test File Hygiene
- NEVER create test/verification files in the project root. Always put them in a dedicated folder:
  - For ad-hoc verification scripts: test/verification/
  - For unit tests: test/ or __tests__/ (match existing project conventions)
- After verification passes, DELETE any temporary test scripts that are not part of the final deliverable.
  Example: if you created test/verification/check.js to verify your work, delete it after it passes.
- The only test files that should remain are ones the user explicitly asked for or that are part of the project's test suite.
- Before declaring done, run list_files on the project root to confirm no stray test files were left behind.
`;

const REVIEWER_TOOLS_PROMPT = `

## Your Tools
You have these tools: list_files, read_file, write_file, run_command, do_test, return_review.

## Review Protocol
1. INSPECT: Read all modified and relevant files. Do NOT re-read a file that is already in the conversation history above.
2. WRITE INDEPENDENT TEST: Use **do_test(code)** to create and run your OWN test / verification script. Do NOT rely on tests written by the coder — write a fresh one that exercises the behavior from a different angle.
   - Pass the complete test code to do_test. It will be saved to test/{taskId}/reviewer{index}/ and executed automatically.
   - The test must exercise actual behavior: call functions, check outputs, assert edge cases.
   - Include the testing framework and assertions directly in your code — do not assume external test runners like jest or pytest are installed. Use built-in asserts (Node assert, Python assert, console.assert, etc.).
   - The execution result is returned to you. Report whether it passed or failed.
   - If you need to create auxiliary files (test data, mocks), use write_file.
3. EVALUATE against this checklist:
   - CORRECTNESS: Does the code do what the task requires? Are there logic bugs or off-by-one errors?
   - SECURITY: Are there injection risks, unsafe inputs, or leaked secrets?
   - PERFORMANCE: Any obvious inefficiencies, N+1 queries, or unnecessary complexity?
   - TESTS: Did YOUR independent test (via do_test) pass? If it failed, report exactly what failed.
   - STYLE: Is the code clean, consistent with the existing codebase, and well-documented?
   - EDGE CASES: Are errors and boundary conditions handled?
4. FEEDBACK: Provide specific, actionable feedback with file names and line references where applicable.

## Final Submission
You MUST call **return_review(report, approved)** as your final action. This is CRITICAL:
- return_review MUST be the ONLY tool call in the assistant message.
- Do NOT include any other tool calls alongside return_review.
- Do NOT write any text before or after calling return_review.
- Your entire response should consist of ONLY the return_review tool call and nothing else.
- report: a structured string with these sections:
  FILES_CHECKED: which files you inspected
  TEST_APPROACH: what behavior your independent test exercised
  KEY_FINDINGS: correctness issues, bugs, or gaps noted
  IMPACT_ON_PLAN: whether completed work suggests changes to remaining subtasks
- approved: true only if all checklist items pass AND your independent test passed. Otherwise false.`;


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
    this.provider = createProvider(config.provider, {
      model: config.model,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      numCtx: config.numCtx || (process.env.OLLAMA_NUM_CTX ? parseInt(process.env.OLLAMA_NUM_CTX, 10) : undefined),
    });
    this.sandbox = new Sandbox(process.cwd());
  }

  async run(taskDescription: string, options: RunOptions = {}): Promise<RunResult> {
    return this._run(taskDescription, options);
  }

  private async _run(taskDescription: string, options: RunOptions = {}): Promise<RunResult> {
    const startTime = Date.now();

    // ── Banner ────────────────────────────────────────────────
    console.log();
    console.log(chalk.cyan(boxTop()));
    console.log(chalk.cyan(boxLine(chalk.bold("🐝 SWARM") + chalk.gray(` v${this.config.version || getPackageVersion()}`))));
    console.log(chalk.cyan(boxSep()));
    console.log(chalk.cyan(boxLine(`${chalk.white("Model:")}  ${this.config.model}`)));
    console.log(chalk.cyan(boxLine(`${chalk.white("Dir:")}    ${this.sandbox.getRoot()}`)));
    console.log(chalk.cyan(boxBottom()));
    console.log();

    // ── Phase 1: Planning (Architect) ────────────────────────
    const architectTools = createArchitectTools(this.sandbox, this.provider, this.config.model, this.config);
    const architect = new ArchitectAgent(this.provider, this.config.model, architectTools, this.sandbox.getRoot());
    const resumeCompleted = options.resumeCompleted || [];

    let plan: TaskPlan;
    if (options.resumePlan) {
      // Resume mode — skip planning, reuse existing plan
      plan = options.resumePlan;
      console.log(chalk.magenta(`${"─".repeat(60)}`));
      console.log(chalk.magenta.bold("🧠 PHASE 1: RESUMING PREVIOUS PLAN"));
      console.log(chalk.magenta(`${"─".repeat(60)}`));
      this.printPlan(plan);
      if (resumeCompleted.length > 0) {
        console.log(chalk.green(`  ✅ Already completed: ${resumeCompleted.join(", ")}`));
      }
    } else {
      console.log(chalk.magenta(`${"─".repeat(60)}`));
      console.log(chalk.magenta.bold("🧠 PHASE 1: PLANNING"));
      console.log(chalk.magenta(`${"─".repeat(60)}`));
      plan = await architect.plan(taskDescription);
      this.printPlan(plan);
    }

    // ── Phase 2: Pipeline Execution ──────────────────────────
    console.log(chalk.blue(`${"─".repeat(60)}`));
    console.log(chalk.blue.bold("⚡ PHASE 2: EXECUTION"));
    console.log(chalk.blue(`${"─".repeat(60)}`));

    // Start run-command listener (only in non-TUI, non-piped contexts)
    const controller = options.enableRunCommands ? new RunController() : null;
    controller?.start();

    let subtaskResults: Record<string, AgentResult[]>;
    let stopped = false;
    try {
      const pipelineResult = await this.executePipeline(taskDescription, plan, architect, resumeCompleted, controller);
      subtaskResults = pipelineResult.results;
      stopped = pipelineResult.stopped;
    } finally {
      controller?.stop();
    }

    const allResults = Object.values(subtaskResults).flat();
    const allOutput = allResults.map((r) => r.output).filter(Boolean).join("\n\n");
    const completedIds = Object.keys(subtaskResults);

    // ── Phase 2b: Completion Report (skip if user stopped early) ─
    if (!stopped) {
      console.log(chalk.magenta(`\n${"─".repeat(60)}`));
      console.log(chalk.magenta.bold("📝 COMPLETION REPORT"));
      console.log(chalk.magenta(`${"─".repeat(60)}`));

      const report = await architect.generateReport(taskDescription, plan, completedIds, allOutput);
      console.log();
      for (const line of report.split("\n")) {
        console.log(chalk.white(`  ${line}`));
      }
      console.log();
    }

    // ── Phase 3: Summary ──────────────────────────────────────
    const duration = Date.now() - startTime;

    const subtaskTokens = allResults.reduce(
      (acc, r) => ({
        prompt: acc.prompt + r.tokenUsage.prompt,
        completion: acc.completion + r.tokenUsage.completion,
        reasoning: acc.reasoning + r.tokenUsage.reasoning,
      }),
      { prompt: 0, completion: 0, reasoning: 0 }
    );

    // Include architect's token usage (planning + replanning + report calls)
    const archTokens = architect.getTokenUsage();
    const totalTokens = {
      prompt: subtaskTokens.prompt + archTokens.prompt,
      completion: subtaskTokens.completion + archTokens.completion,
      reasoning: subtaskTokens.reasoning + archTokens.reasoning,
    };

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
      plan,
      completed: completedIds,
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
      completed: completedIds,
      failed: failedIds.map((s) => s.id),
    };
  }

  // ── Pipeline Execution (sequential) ─────────────────────

  /**
   * Sequential execution: one subtask at a time, fully completing each
   * (coder → reviewer 1 → replan → reviewer 2 → replan → consensus → next)
   * before moving to the next ready subtask.
   */
  private async executePipeline(
    taskDescription: string,
    plan: TaskPlan,
    architect: ArchitectAgent,
    initialCompleted: string[] = [],
    controller: RunController | null = null
  ): Promise<{ results: Record<string, AgentResult[]>; stopped: boolean }> {
    const results: Record<string, AgentResult[]> = {};
    const completed = new Set<string>(initialCompleted);
    const failed = new Set<string>();
    const reviewRounds = new Map<string, number>();

    // Seed controller with resume count
    if (controller) {
      controller.completedCount = initialCompleted.length;
      controller.totalSubtasks = plan.subtasks.length;
    }

    let index = 0;
    while (index < plan.subtasks.length) {
      const subtask = plan.subtasks[index];
      index++;
      if (completed.has(subtask.id) || failed.has(subtask.id)) continue;

      // Keep total in sync — architect replanning can change plan.subtasks
      if (controller) controller.totalSubtasks = plan.subtasks.length;

      // /stop — finish gracefully before starting the next subtask
      if (controller?.stopRequested) {
        console.log(chalk.yellow("\n⚡ Stopping run as requested — no more subtasks will run.\n"));
        return { results, stopped: true };
      }

      // /skip — skip this subtask before it even starts
      if (controller?.consumeSkip()) {
        console.log(chalk.yellow(`\n⚡ Skipping ${subtask.id}: ${subtask.title}\n`));
        failed.add(subtask.id);
        continue;
      }

      controller?.update(subtask.id, subtask.title, index, plan.subtasks.length);

      try {
        await this.processSubtask(
          subtask,
          plan,
          results,
          completed,
          failed,
          reviewRounds,
          taskDescription,
          architect,
          controller
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`  ❌ [${subtask.id}] unhandled pipeline error: ${msg}`));
        failed.add(subtask.id);
      }

      if (controller && completed.has(subtask.id)) {
        controller.completedCount++;
      }
    }

    return { results, stopped: false };
  }

  /**
   * Process a single subtask: coder → parallel reviewers → architect replan → done.
   * The architect investigates the current state and adjusts the remaining plan
   * before this method returns, ensuring the next subtask starts with an up-to-date plan.
   */
  private async processSubtask(
    subtask: Subtask,
    plan: TaskPlan,
    results: Record<string, AgentResult[]>,
    completed: Set<string>,
    failed: Set<string>,
    reviewRounds: Map<string, number>,
    taskDescription: string,
    architect: ArchitectAgent,
    controller: RunController | null = null
  ): Promise<void> {
    const cache = new FileCache();
    const coderConfig = this.config.agents.coder;

    const allResults: AgentResult[] = [];

    console.log(chalk.blue(`\n  ├─── ${subtask.title} ───`));

    // ── Create coder with conversation continuity ──────────
    const coder = new LLMAgent(
      {
        role: `coder:${subtask.id}`,
        systemPrompt: coderConfig.systemPrompt + CODER_TOOLS_PROMPT + `\n\nCurrent project directory: ${this.sandbox.getRoot()}`,
      },
      this.config.model,
      this.provider,
      createCoderTools(this.sandbox, this.config, cache)
    );

    // Start coder conversation
    const fileHints = subtask.filesExpected
      ? `\n\nFiles you are expected to create or modify: ${subtask.filesExpected.join(", ")}`
      : "";
    const complexityHint = subtask.estimatedComplexity
      ? `\nEstimated complexity: ${subtask.estimatedComplexity}`
      : "";

    coder.startTask({
      id: `task-${subtask.id}-coder`,
      description: subtask.description,
      messages: [{ role: "user", content: `Task: ${subtask.description}${fileHints}${complexityHint}\n\nBegin implementing the task now. Use your tools.` }],
    });

    // ── First coder pass ───────────────────────────────────
    console.log(chalk.blue(`  │ 🛠  Coder`));
    const firstResult = await coder.continueChat("");
    allResults.push({
      taskId: `coder:${subtask.id}:0`,
      agentRole: `coder:${subtask.id}`,
      output: firstResult.output,
      tokenUsage: firstResult.tokenUsage,
      duration: 0,
    });

    // Stubborn retry: coder must actually modify files
    let stubbornRetries = 0;
    while (!coder.hasModifiedFiles() && stubbornRetries < 2) {
      stubbornRetries++;
      console.log(chalk.yellow(`  │ ⚠ No files modified — stubborn retry ${stubbornRetries}/2`));
      const stubbornResult = await coder.continueChat(
        `IMPORTANT: You have not yet created or modified any files. You MUST use write_file, edit_file, or run_command to implement this task. Empty responses are not acceptable. Please implement the task now.`
      );
      allResults.push({
        taskId: `coder:${subtask.id}:stubborn-${stubbornRetries}`,
        agentRole: `coder:${subtask.id}`,
        output: stubbornResult.output,
        tokenUsage: stubbornResult.tokenUsage,
        duration: 0,
      });
    }

    // Cleanup stray test files after coder pass
    await this.cleanupStrayTestFiles();

    if (!coder.hasModifiedFiles()) {
      console.log(chalk.red(`  │ ❌ Coder failed to modify files after ${stubbornRetries} retries. Notifying architect to modify plan...`));

      const failureFeedback = {
        report: `The coder was unable to create or modify any files for subtask "${subtask.title}" (${subtask.id}) after ${stubbornRetries} attempts. The task description or expected files may need to be revised, or the subtask may need to be broken down into smaller steps.`,
        source: `Coder auto-failure for ${subtask.id}`,
        reviewStatus: "NEEDS_WORK",
      };

      console.log(chalk.magenta(`  🔄 Architect reviewing coder failure before next subtask...`));
      const newPlan = await architect.replanWithInvestigation(
        taskDescription,
        plan,
        [...completed],
        Object.fromEntries(
          Object.entries(results).map(([k, v]) => [k, v.map((r) => ({ agentRole: r.agentRole, output: r.output }))])
        ),
        [failureFeedback]
      );

      if (newPlan) {
        plan.subtasks = newPlan.subtasks;
        if (newPlan.rationale) plan.rationale = newPlan.rationale;
        console.log(chalk.magenta(`  ✅ Plan updated by architect after coder failure`));
        const updatedRemaining = plan.subtasks.filter((s) => !completed.has(s.id) && s.id !== subtask.id);
        for (const s of updatedRemaining) {
          const files = s.filesExpected ? chalk.gray(` 📄 ${s.filesExpected.join(", ")}`) : "";
          console.log(chalk.magenta(`     └─ ${s.id}: ${s.title}${files}`));
        }
      } else {
        console.log(chalk.magenta(`  ⏭  Architect: sticking to current plan`));
      }

      results[subtask.id] = allResults;
      failed.add(subtask.id);
      return;
    }

    // ── Reviewer consensus loop ──────────────────────────
    // /skip — bail out after coder but before reviewers run.
    // Architect will investigate and update the plan accordingly.
    if (controller?.consumeSkip()) {
      console.log(chalk.yellow(`\n⚡ Skipping reviews for ${subtask.id} — running architect replan with partial work\n`));
      const skipFeedback = {
        report: `Subtask "${subtask.title}" (${subtask.id}) was skipped by the user after the coder ran. The coder may have partially implemented the work. The architect should account for any changes already made when updating the plan.`,
        source: `User /skip for ${subtask.id}`,
        reviewStatus: "NEEDS_WORK",
      };
      const newPlan = await architect.replanWithInvestigation(
        taskDescription, plan, [...completed],
        Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.map((r) => ({ agentRole: r.agentRole, output: r.output }))])),
        [skipFeedback]
      );
      if (newPlan) {
        plan.subtasks = newPlan.subtasks;
        if (newPlan.rationale) plan.rationale = newPlan.rationale;
        console.log(chalk.magenta(`  ✅ Plan updated by architect after skip`));
      }
      results[subtask.id] = allResults;
      failed.add(subtask.id);
      return;
    }

    let reviewRound = 0;
    let modifiedFiles = coder.getModifiedFiles();
    let coderSummary = allResults[allResults.length - 1]?.output || "";
    let finalReviewA: AgentResult | undefined;
    let finalReviewB: AgentResult | undefined;

    while (reviewRound <= this.maxReviewerRounds) {
      console.log(chalk.blue(`  │ 🔍 Reviewers (round ${reviewRound})`));

      // ── Run both reviewers in parallel ─────────────────────
      const [reviewA, reviewB] = await Promise.all([
        this.runReviewer(subtask, reviewRound, 1, modifiedFiles, coderSummary),
        this.runReviewer(subtask, reviewRound, 2, modifiedFiles, coderSummary),
      ]);
      allResults.push(reviewA, reviewB);
      finalReviewA = reviewA;
      finalReviewB = reviewB;

      const approvedA = reviewA.output.includes("[STATUS: APPROVED]");
      const approvedB = reviewB.output.includes("[STATUS: APPROVED]");
      const consensus = approvedA && approvedB;

      if (consensus) {
        console.log(chalk.green(`  │ ✅ Approved by consensus (2/2)`));
        break;
      }

      if (reviewRound >= this.maxReviewerRounds) {
        console.log(chalk.yellow(`  │ ⏰ Max review rounds reached — accepting without consensus`));
        break;
      }

      // ── NEEDS_WORK — continue coder conversation ─────────
      console.log(chalk.yellow(`  │ 🔄 Needs work — sending feedback to coder`));
      reviewRounds.set(subtask.id, (reviewRounds.get(subtask.id) || 0) + 1);
      console.log(chalk.blue(`  │ 🛠  Coder (fix round ${reviewRound + 1})`));

      const feedback = this.buildConsensusFeedback(reviewA, reviewB, approvedA, approvedB);
      const fixResult = await coder.continueChat(feedback);

      allResults.push({
        taskId: `coder:${subtask.id}:fix-${reviewRound}`,
        agentRole: `coder:${subtask.id}`,
        output: fixResult.output,
        tokenUsage: fixResult.tokenUsage,
        duration: 0,
      });

      // Refresh state for next review round
      modifiedFiles = coder.getModifiedFiles();
      coderSummary = fixResult.output;
      reviewRound++;

      // Cleanup stray test files after each coder round
      await this.cleanupStrayTestFiles();
    }

    // ── Architect replan with investigation ────────────────
    // Block next subtask until architect confirms plan or updates it
    if (completed.size < plan.subtasks.length) {
      const reportA = this.extractReviewerReport(finalReviewA?.output || "");
      const reportB = this.extractReviewerReport(finalReviewB?.output || "");
      const feedbacks: Array<{ report: string; source: string; reviewStatus: string }> = [];
      if (reportA) {
        feedbacks.push({
          report: reportA,
          source: `Reviewer 1 for ${subtask.id}`,
          reviewStatus: finalReviewA!.output.includes("[STATUS: APPROVED]") ? "APPROVED" : "NEEDS_WORK",
        });
      }
      if (reportB) {
        feedbacks.push({
          report: reportB,
          source: `Reviewer 2 for ${subtask.id}`,
          reviewStatus: finalReviewB!.output.includes("[STATUS: APPROVED]") ? "APPROVED" : "NEEDS_WORK",
        });
      }

      console.log(chalk.magenta(`  🔄 Architect reviewing completed work before next subtask...`));
      const newPlan = await architect.replanWithInvestigation(
        taskDescription,
        plan,
        [...completed, subtask.id],
        Object.fromEntries(
          Object.entries(results).map(([k, v]) => [k, v.map((r) => ({ agentRole: r.agentRole, output: r.output }))])
        ),
        feedbacks
      );

      if (newPlan) {
        plan.subtasks = newPlan.subtasks;
        if (newPlan.rationale) plan.rationale = newPlan.rationale;
        console.log(chalk.magenta(`  ✅ Plan updated by architect`));
        // Print updated remaining
        const updatedRemaining = plan.subtasks.filter((s) => !completed.has(s.id) && s.id !== subtask.id);
        for (const s of updatedRemaining) {
          const files = s.filesExpected ? chalk.gray(` 📄 ${s.filesExpected.join(", ")}`) : "";
          console.log(chalk.magenta(`     └─ ${s.id}: ${s.title}${files}`));
        }
      } else {
        console.log(chalk.magenta(`  ⏭  Architect: sticking to current plan`));
      }
    }

    // ── Verification gate (FYI) ────────────────────────────
    if (subtask.verification) {
      console.log(chalk.blue(`  │ 🧪 Architect verification: ${subtask.verification}`));
      const verifier = createRunCommandTool(this.sandbox);
      const vResult = await verifier.execute({ command: subtask.verification, timeout: 60 });
      const vFailed = vResult.includes("EXIT CODE:") && !vResult.includes("EXIT CODE: 0");

      if (!vFailed) {
        console.log(chalk.green(`  │ ✅ Verification passed`));
      } else {
        console.log(chalk.yellow(`  │ ⚠ Verification failed (reviewers already approved with independent tests)`));
        console.log(chalk.gray(`  │ ${vResult.slice(0, 200)}...`));
      }
    }

    // ── Cleanup stray test files from project root ──────────
    await this.cleanupStrayTestFiles();

    // Mark done
    results[subtask.id] = allResults;
    completed.add(subtask.id);
  }

  /**
   * Scan the project root for test/verification files and move them to test/.
   * Patterns matched: test*.js, test*.py, test*.html, *_test.*, *_spec.*, verify*.
   */
  private async cleanupStrayTestFiles(): Promise<void> {
    const TEST_PATTERNS = [
      /^test[_-]?.*\.(js|ts|py|html|sh)$/i,     // test.js, test2.js, test-clock.js
      /^.+[_-]test\.(js|ts|py|html|sh)$/i,       // app_test.js, my-test.js
      /^.+[_-]spec\.(js|ts|py|html|sh)$/i,       // app_spec.js
      /^verify[_-]?.*\.(js|ts|py|html|sh)$/i,    // verify.js, verify-clock.js
      /^check[_-]?.*\.(js|ts|py|html|sh)$/i,     // check.js
      /^debug[_-]?.*\.(js|ts|py|html|sh)$/i,     // debug.js
      /^temp[_-]?.*\.(js|ts|py|html|sh)$/i,      // temp.js
      /^tmp[_-]?.*\.(js|ts|py|html|sh)$/i,       // tmp.js
    ];

    const SKIP_DIRS = new Set(["node_modules", ".git", "test", "__tests__", "dist", "build"]);

    try {
      const root = this.sandbox.getRoot();
      const entries = await readdir(root, { withFileTypes: true });
      const strayFiles: string[] = [];

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue; // skip dotfiles

        const isTestFile = TEST_PATTERNS.some((p) => p.test(entry.name));
        if (isTestFile) {
          strayFiles.push(entry.name);
        }
      }

      if (strayFiles.length === 0) return;

      // Ensure test/ directory exists
      const testDir = join(root, "test");
      await mkdir(testDir, { recursive: true });

      for (const file of strayFiles) {
        const src = join(root, file);
        const dest = join(testDir, file);
        try {
          await rename(src, dest);
          console.log(chalk.gray(`  │ 🧹 Moved stray test file: ${file} → test/${file}`));
        } catch {
          // File may have been deleted already or permission issue — skip
        }
      }
    } catch {
      // Non-fatal — cleanup is best-effort
    }
  }

  // ── Reviewer helpers ───────────────────────────────────────

  /**
   * Extract the structured report from a reviewer's output.
   * Looks for [REPORT]...[REPORT] in the output text.
   */
  private extractReviewerReport(output: string): string | null {
    const match = output.match(/\[REPORT\]([\s\S]*?)\[\/REPORT\]/);
    return match ? match[1].trim() : null;
  }

  private async runReviewer(
    subtask: Subtask,
    round: number,
    reviewerIndex: number,
    modifiedFiles: string[],
    coderSummary: string
  ): Promise<AgentResult> {
    const reviewerConfig = this.config.agents.reviewer;
    const reviewer = new LLMAgent(
      {
        role: `reviewer:${subtask.id}-${reviewerIndex}`,
        systemPrompt: reviewerConfig.systemPrompt + REVIEWER_TOOLS_PROMPT + `\n\nCurrent project directory: ${this.sandbox.getRoot()}`,
      },
      this.config.model,
      this.provider,
      createReviewerTools(this.sandbox, subtask.id, reviewerIndex)
    );

    const filesList = modifiedFiles.length > 0
      ? `Files modified by the coder:\n${modifiedFiles.map((f) => `  • ${f}`).join("\n")}`
      : "(The coder did not report any modified files — inspect the codebase to find what was changed.)";

    const summaryBlock = coderSummary
      ? `Coder's summary of changes:\n---\n${coderSummary.slice(0, 1200)}\n---\n`
      : "(No summary provided by the coder.)";

    const result = await reviewer.execute({
      id: `task-${subtask.id}-reviewer-${round}-${reviewerIndex}`,
      description: subtask.description,
      messages: [{
        role: "user",
        content: `Task: ${subtask.description}\n\n${filesList}\n\n${summaryBlock}\n\nReview the code. Read the files listed above, then use **do_test** to write and execute your OWN independent test script.\n\n- do_test(code) saves your test to test/${subtask.id}/reviewer${reviewerIndex}/ and runs it automatically.\n- Include assertions directly in your code. Use built-in assert (Node: require('assert'), Python: assert, etc.).\n- The execution result is returned to you. Report whether your test passed or failed.\n- If you need auxiliary files (test data, mocks), use write_file.\n\nWhen you are done, call **return_review(report, approved)** as your final action. Do not output any text after calling it.`,
      }],
    });

    // Inspect the reviewer's history for the return_review tool call (use the last one)
    const history = reviewer.getHistory();
    const returnCalls = history
      .filter((m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0)
      .flatMap((m) => m.tool_calls!)
      .filter((tc) => tc.name === "return_review");

    const returnCall = returnCalls.length > 0 ? returnCalls[returnCalls.length - 1] : undefined;

    if (returnCall) {
      const report = (returnCall.arguments.report as string) || "";
      const approved = !!returnCall.arguments.approved;
      result.output = `[REPORT]\n${report}\n[/REPORT]\n\n[STATUS: ${approved ? "APPROVED" : "NEEDS_WORK"}]`;
    }

    return result;
  }

  private buildConsensusFeedback(
    r1: AgentResult,
    r2: AgentResult,
    approved1: boolean,
    approved2: boolean
  ): string {
    const parts: string[] = [
      "The reviewers found issues. Here is the review feedback:\n\n",
      `=== Reviewer 1 (${approved1 ? "APPROVED" : "NEEDS_WORK"}) ===\n${r1.output}\n\n`,
      `=== Reviewer 2 (${approved2 ? "APPROVED" : "NEEDS_WORK"}) ===\n${r2.output}\n\n`,
    ];

    if (approved1 && !approved2) {
      parts.push("Note: Reviewer 1 approved but Reviewer 2 did not. Address Reviewer 2's concerns specifically.\n\n");
    } else if (!approved1 && approved2) {
      parts.push("Note: Reviewer 2 approved but Reviewer 1 did not. Address Reviewer 1's concerns specifically.\n\n");
    } else {
      parts.push("Note: Both reviewers rejected the code. Address all concerns above.\n\n");
    }

    parts.push("Fix the issues and improve the code. Use tools to read/edit files.");
    return parts.join("");
  }

  // ── Display helpers ───────────────────────────────────────

  private printPlan(plan: TaskPlan): void {
    console.log(chalk.magenta(`\n  🎯 ${plan.goal}`));
    if (plan.rationale) {
      console.log(chalk.gray(`  🧠 ${plan.rationale.slice(0, 200)}${plan.rationale.length > 200 ? "..." : ""}`));
    }
    console.log(chalk.magenta(`  📦 ${plan.subtasks.length} subtask(s)\n`));

    for (const st of plan.subtasks) {
      const comp = st.estimatedComplexity ? chalk.dim(` [${st.estimatedComplexity}]`) : "";
      const files = st.filesExpected ? chalk.dim(` 📄 ${st.filesExpected.join(", ")}`) : "";
      console.log(chalk.magenta(`  ┌─ ${chalk.bold(st.id)}: ${st.title}${comp}`));
      const desc = st.description.length > 100 ? st.description.slice(0, 100) + "..." : st.description;
      console.log(chalk.magenta(`  └─ ${chalk.dim(desc)}`));
      if (files) console.log(chalk.magenta(`     ${files}`));
      console.log();
    }
  }

  private printSummary(
    plan: TaskPlan,
    completedIds: string[],
    failedIds: Subtask[],
    duration: number,
    totalTokens: { prompt: number; completion: number; reasoning: number }
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
    console.log(chalk.green(boxLine(`  🔧 Tokens: ${totalTokens.prompt + totalTokens.completion + totalTokens.reasoning} total`)));
    console.log(chalk.green(boxLine(`     └─ input: ${totalTokens.prompt} │ output: ${totalTokens.completion} │ reasoning: ${totalTokens.reasoning}`)));

    if (failedIds.length > 0) {
      console.log(chalk.green(boxLine(`  ${chalk.yellow("⚠")}  ${failedIds.length} subtask(s) skipped`)));
    }

    console.log(chalk.green(boxBottom()));
    console.log();
  }
}
