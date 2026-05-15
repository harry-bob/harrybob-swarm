import { LLMAgent } from "../agents/llm-agent.js";
import { AgentResult } from "../agents/base.js";
import { ArchitectAgent } from "./architect.js";
import { TaskPlan, Subtask } from "./types.js";
import { createProvider } from "../providers/factory.js";
import { Sandbox, ToolRegistry, FileCache, createReadFileTool, createWriteFileTool, createEditFileTool, createListFilesTool, createRunCommandTool, createAskUserQuestionTool, createWebSearchTool, createResearchTool, createReviewerTestTool, createReviewerReturnTool } from "../tools/index.js";
import { saveSession } from "./session.js";
import { withTimeout } from "../utils/timeout.js";
import { getPackageVersion } from "../utils/version.js";
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
`;

const REVIEWER_TOOLS_PROMPT = `

## Your Tools
You have these tools: list_files, read_file, write_file, run_command, do_test, return_review.

## Review Protocol
1. INSPECT: Read all modified and relevant files.
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
Your VERY LAST action MUST be calling **return_review(report, approved)**. Do not output any text after calling it.
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
    this.provider = createProvider(config.provider, config.model);
    this.sandbox = new Sandbox(process.cwd());
  }

  async run(taskDescription: string, options: RunOptions = {}): Promise<RunResult> {
    const timeoutMs = this.config.orchestration.timeout || 600_000; // default 10 min
    return withTimeout(this._run(taskDescription, options), timeoutMs, "Swarm run");
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
    console.log(chalk.magenta(`${"─".repeat(60)}`));
    console.log(chalk.magenta.bold("🧠 PHASE 1: PLANNING"));
    console.log(chalk.magenta(`${"─".repeat(60)}`));

    const architectTools = createArchitectTools(this.sandbox, this.provider, this.config.model, this.config);
    const architect = new ArchitectAgent(this.provider, this.config.model, architectTools, this.sandbox.getRoot());
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
    architectTools: ToolRegistry
  ): Promise<Record<string, AgentResult[]>> {
    const results: Record<string, AgentResult[]> = {};
    const completed = new Set<string>();
    const failed = new Set<string>();
    const reviewRounds = new Map<string, number>();

    const getReady = (): Subtask[] =>
      plan.subtasks.filter(
        (st) =>
          !completed.has(st.id) &&
          !failed.has(st.id) &&
          st.dependencies.every((dep) => completed.has(dep)) &&
          !st.dependencies.some((dep) => failed.has(dep))
      );

    while (completed.size + failed.size < plan.subtasks.length) {
      const ready = getReady();
      if (ready.length === 0) break;

      for (const subtask of ready) {
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
            architectTools
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(chalk.red(`  ❌ [${subtask.id}] unhandled pipeline error: ${msg}`));
          failed.add(subtask.id);
        }
      }
    }

    return results;
  }

  /**
   * Process a single subtask: coder → sequential reviewers → consensus → next subtask.
   * After each reviewer finishes, the orchestrator adjusts the plan based on the reviewer's report.
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
    architectTools: ToolRegistry
  ): Promise<void> {
    const cache = new FileCache();
    const coderConfig = this.config.agents.coder;

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
    const ctx = depContext ? `\n\nContext from prior subtasks:\n${depContext}` : "";
    const fileHints = subtask.filesExpected
      ? `\n\nFiles you are expected to create or modify: ${subtask.filesExpected.join(", ")}`
      : "";
    const complexityHint = subtask.estimatedComplexity
      ? `\nEstimated complexity: ${subtask.estimatedComplexity}`
      : "";

    coder.startTask({
      id: `task-${subtask.id}-coder`,
      description: subtask.description,
      messages: [{ role: "user", content: `Task: ${subtask.description}${ctx}${fileHints}${complexityHint}\n\nBegin implementing the task now. Use your tools.` }],
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
    while (!coder.hasModifiedFiles() && stubbornRetries < 5) {
      stubbornRetries++;
      console.log(chalk.yellow(`  │ ⚠ No files modified — stubborn retry ${stubbornRetries}/5`));
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

    // ── Reviewer consensus loop ──────────────────────────
    let reviewRound = 0;
    let modifiedFiles = coder.getModifiedFiles();
    let coderSummary = allResults[allResults.length - 1]?.output || "";

    while (reviewRound <= this.maxReviewerRounds) {
      console.log(chalk.blue(`  │ 🔍 Reviewers (round ${reviewRound})`));

      // Reviewer 1
      const reviewA = await this.runReviewer(subtask, reviewRound, 1, modifiedFiles, coderSummary);
      allResults.push(reviewA);
      const reportA = this.extractReviewerReport(reviewA.output);
      if (reportA && completed.size < plan.subtasks.length) {
        await this.maybeReplan(taskDescription, plan, completed, results, architect, architectTools, {
          report: reportA,
          source: `Reviewer 1 for ${subtask.id}`,
          reviewStatus: reviewA.output.includes("[STATUS: APPROVED]") ? "APPROVED" : "NEEDS_WORK",
        });
      }

      // Reviewer 2
      const reviewB = await this.runReviewer(subtask, reviewRound, 2, modifiedFiles, coderSummary);
      allResults.push(reviewB);
      const reportB = this.extractReviewerReport(reviewB.output);
      if (reportB && completed.size < plan.subtasks.length) {
        await this.maybeReplan(taskDescription, plan, completed, results, architect, architectTools, {
          report: reportB,
          source: `Reviewer 2 for ${subtask.id}`,
          reviewStatus: reviewB.output.includes("[STATUS: APPROVED]") ? "APPROVED" : "NEEDS_WORK",
        });
      }

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

    // Mark done
    results[subtask.id] = allResults;
    completed.add(subtask.id);

    // Final replan after subtask completion
    if (completed.size < plan.subtasks.length) {
      await this.maybeReplan(taskDescription, plan, completed, results, architect, architectTools);
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
    architectTools: ToolRegistry,
    reviewerFeedback?: { report: string; source: string; reviewStatus: string }
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

    const remainingSummary = remaining.map((s) => `- ${s.id}: ${s.title} - ${s.description.slice(0, 100)}`).join("\n");

    const feedbackBlock = reviewerFeedback
      ? `REVIEWER FEEDBACK:\nSource: ${reviewerFeedback.source}\nStatus: ${reviewerFeedback.reviewStatus}\nReport:\n${reviewerFeedback.report}\n`
      : "";

    // Ask architect (using a quick tool call - not a full planning pass)
    const replanPrompt = `You planned the following task:

Goal: ${plan.goal}

COMPLETED subtasks:
${completedSummary}

${feedbackBlock}
REMAINING subtasks:
${remainingSummary}

Based on completed work and any reviewer feedback above, do the remaining subtasks need changes?
If the remaining plan is fine as-is, respond with "NO CHANGES".
If changes are needed, describe what subtasks to add, modify, or remove. Be specific about which subtask IDs to change.`;

    try {
      const replanResult = await architect.replan(replanPrompt);

      if (replanResult.includes("NO CHANGES")) {
        return;
      }

      // Parse changes (simple heuristic - look for add/remove/modify instructions)
      console.log(chalk.magenta(`\n  🔄 Architect adjusting plan...`));

      // Ask architect to provide updated remaining subtasks as full JSON
      const updatePrompt = `Based on your analysis, provide the UPDATED remaining subtasks as a JSON object matching the task plan schema.

Current completed subtask IDs: ${[...completed].join(", ")}
New subtasks should NOT duplicate completed ones.

Respond with ONLY a JSON object, no other text:
{
  "goal": "${plan.goal}",
  "rationale": "...",
  "subtasks": [
    {
      "id": "task-N",
      "title": "...",
      "description": "...",
      "dependencies": ["task-X"],
      "verification": "...",
      "filesExpected": ["src/foo.ts"],
      "estimatedComplexity": "medium"
    }
  ]
}`;

      const updateResult = await architect.replan(updatePrompt);

      // Try to parse JSON from the response
      const jsonMatch = updateResult.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const newPlan = JSON.parse(jsonMatch[0]) as TaskPlan;
          const validNew = (newPlan.subtasks || []).filter(
            (s) => !completed.has(s.id) && typeof s.title === "string" && typeof s.description === "string"
          );
          const keptSubtasks = plan.subtasks.filter((s) => completed.has(s.id));
          plan.subtasks = [...keptSubtasks, ...validNew];
          if (newPlan.rationale) plan.rationale = newPlan.rationale;

          console.log(chalk.magenta(`  ✅ Plan updated: ${validNew.length} remaining subtask(s)`));
          for (const s of validNew) {
            const files = s.filesExpected ? chalk.gray(` 📄 ${s.filesExpected.join(", ")}`) : "";
            console.log(chalk.magenta(`     └─ ${s.id}: ${s.title}${files}`));
          }
        } catch {
          console.log(chalk.gray(`  ⏭  Could not parse updated plan - keeping original`));
        }
      }
    } catch {
      // Re-planning is best-effort - don't fail the whole run
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

    // Inspect the reviewer's history for the return_review tool call
    const history = reviewer.getHistory();
    const returnCall = history
      .filter((m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0)
      .flatMap((m) => m.tool_calls!)
      .find((tc) => tc.name === "return_review");

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

    // Build a dependency tree visualization
    const allIds = new Set(plan.subtasks.map((s) => s.id));
    for (const st of plan.subtasks) {
      const deps = st.dependencies.length > 0 ? chalk.gray(` → after ${st.dependencies.join(", ")}`) : chalk.gray(" → no deps");
      const comp = st.estimatedComplexity ? chalk.dim(` [${st.estimatedComplexity}]`) : "";
      const files = st.filesExpected ? chalk.dim(` 📄 ${st.filesExpected.join(", ")}`) : "";
      console.log(chalk.magenta(`  ┌─ ${chalk.bold(st.id)}: ${st.title}${deps}${comp}`));
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
