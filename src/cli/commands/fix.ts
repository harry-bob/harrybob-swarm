import { Command } from "commander";
import { Orchestrator } from "../../core/orchestrator.js";
import { loadConfig } from "../../config/config.js";
import { loadSession } from "../../core/session.js";
import { logError, logInfo, logWarning } from "../../utils/logger.js";
import chalk from "chalk";

export function fixCommand(program: Command): void {
  program
    .command("fix <issue>")
    .description("Fix a bug or issue using context from the previous run")
    .option("--model <model>", "Override model for this run")

    .option("--verbose", "Enable verbose output", false)
    .action(async (issue: string, options) => {
      const config = await loadConfig();
      if (!config) {
        logError("No swarm configuration found. Run `swarm init` first.");
        process.exit(1);
      }

      if (options.model) {
        config.model = options.model;
      }

      const session = await loadSession();

      if (!session) {
        logWarning("No previous session found. Run `swarm run` first, or use `swarm run` for a new task.");
        logInfo("Falling back to regular run...");
      }

      const contextHint = session
        ? `\n\nPrevious task: "${session.lastTask}"\nFiles created: ${session.filesCreated.join(", ")}\nPlan summary: ${session.lastPlan || "N/A"}\n\nThe user is reporting a bug or issue with the previous output. Investigate the existing code, find the problem, and fix it.`
        : "";

      const fullTask = `FIX/DEBUG REQUEST: ${issue}${contextHint}`;

      logInfo(`Fixing: "${issue}"`);
      if (session) logInfo(`Previous context: ${session.lastTask.slice(0, 80)}...`);
      logInfo(`Model: ${chalk.bold(config.model)}`);

      const orchestrator = new Orchestrator(config);

      try {
        const result = await orchestrator.run(fullTask, {
          verbose: options.verbose,
          enableRunCommands: true,
        });

        console.log("\n" + "=".repeat(60));
        console.log("📋 RESULT:");
        console.log("=".repeat(60));
        console.log(result.output);
        console.log("=".repeat(60));
        console.log(`⏱  Duration: ${result.duration}ms`);
        console.log(`🤖 Agents used: ${result.agentsUsed.join(", ")}`);

        process.exit(0);
      } catch (error) {
        logError(`Fix failed: ${error}`);
        process.exit(1);
      }
    });
}
