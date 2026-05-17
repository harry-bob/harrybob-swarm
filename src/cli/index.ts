import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config/config.js";
import { loadSession } from "../core/session.js";
import { Orchestrator } from "../core/orchestrator.js";
import { initCommand } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { fixCommand } from "./commands/fix.js";
import { statusCommand } from "./commands/status.js";
import { ollamaCommand } from "./commands/ollama.js";
import { chatCommand, runChat } from "./commands/chat.js";
import { loginCommand } from "./commands/login.js";
import { getPackageVersion } from "../utils/version.js";

export function createCLI(): Command {
  const program = new Command();

  program
    .name("swarm")
    .description("CLI swarm agent developer tool with multi-agent orchestration")
    .version(getPackageVersion())
    .option("--continue", "Resume the last swarm session from where it left off");

  // register commands
  initCommand(program);
  runCommand(program);
  fixCommand(program);
  chatCommand(program);
  statusCommand(program);
  ollamaCommand(program);
  loginCommand(program);

  // default action: interactive chat when no subcommand is given
  program.action(async (options) => {
    const config = await loadConfig();
    if (!config) {
      console.log(chalk.red("No swarm configuration found. Run `swarm init` first."));
      process.exit(1);
    }

    // --continue: resume the last session
    if (options.continue) {
      const session = await loadSession();
      if (!session) {
        console.log(chalk.red("No previous session found. Run `swarm run <task>` first."));
        process.exit(1);
      }
      if (!session.plan) {
        console.log(chalk.red("Previous session has no saved plan. Run `swarm run <task>` to start a new session."));
        process.exit(1);
      }

      const completed = session.completed || [];
      const remaining = session.plan.subtasks.filter((s) => !completed.includes(s.id));
      if (remaining.length === 0) {
        console.log(chalk.green("All subtasks from the previous session are already complete."));
        process.exit(0);
      }

      console.log(chalk.cyan(`Resuming: "${session.lastTask}"`));
      console.log(chalk.gray(`${completed.length} done, ${remaining.length} remaining`));

      const orchestrator = new Orchestrator(config);
      try {
        const result = await orchestrator.run(session.lastTask, {
          resumePlan: session.plan,
          resumeCompleted: completed,
        });
        console.log("\n" + "=".repeat(60));
        console.log("📋 RESULT:");
        console.log("=".repeat(60));
        if (result.plan) {
          console.log(`\n🎯 Goal: ${result.plan.goal}`);
          for (const st of result.plan.subtasks) {
            const icon = result.completed.includes(st.id) ? "✅" : result.failed.includes(st.id) ? "❌" : "⬜";
            console.log(`  ${icon} [${st.id}] ${st.title}`);
          }
        }
        const tu = result.tokenUsage;
        console.log(`\n🔧 Tokens: ${tu.prompt + tu.completion + tu.reasoning} total`);
        console.log("=".repeat(60));
        process.exit(0);
      } catch (error) {
        console.log(chalk.red(`Task failed: ${error}`));
        process.exit(1);
      }
      return;
    }

    await runChat(config);
  });

  return program;
}
