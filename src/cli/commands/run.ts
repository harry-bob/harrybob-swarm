import { Command } from "commander";
import { Orchestrator } from "../../core/orchestrator.js";
import { loadConfig } from "../../config/config.js";
import { logError, logInfo } from "../../utils/logger.js";
import chalk from "chalk";

export function runCommand(program: Command): void {
  program
    .command("run <task>")
    .description("Run a task with the swarm")
    .option("--agents <agents...>", "Specific agents to use")
    .option("--model <model>", "Override model for this run")
    .option("--verbose", "Enable verbose output", false)
    .action(async (task: string, options) => {
      const config = await loadConfig();
      if (!config) {
        logError("No swarm configuration found. Run `swarm init` first.");
        process.exit(1);
      }

      if (options.model) {
        config.model = options.model;
      }

      logInfo(`Running task: "${task}"`);
      logInfo(`Model: ${chalk.bold(config.model)}`);

      const orchestrator = new Orchestrator(config);

      try {
        const result = await orchestrator.run(task, {
          agents: options.agents,
          verbose: options.verbose,
        });

        console.log("\n" + "=".repeat(60));
        console.log("📋 RESULT:");
        console.log("=".repeat(60));
        if (result.plan) {
          console.log(`\n🎯 Goal: ${result.plan.goal}`);
          console.log(`📦 Subtasks: ${result.plan.subtasks.length}`);
          for (const st of result.plan.subtasks) {
            const status = result.output.includes(st.id) ? "✅" : "⬜";
            console.log(`  ${status} [${st.id}] ${st.title}`);
          }
          console.log();
        }
        console.log(result.output);
        console.log("=".repeat(60));
        console.log(`⏱  Duration: ${result.duration}ms`);
        console.log(`🤖 Agents used: ${result.agentsUsed.join(", ")}`);
        console.log(`🔄 Iterations: ${result.iterations}`);
      } catch (error) {
        logError(`Task failed: ${error}`);
        process.exit(1);
      }
    });
}
