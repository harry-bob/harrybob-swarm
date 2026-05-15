import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config/config.js";
import { initCommand } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { fixCommand } from "./commands/fix.js";
import { statusCommand } from "./commands/status.js";
import { ollamaCommand } from "./commands/ollama.js";
import { chatCommand, runChat } from "./commands/chat.js";
import { loginCommand } from "./commands/login.js";
import { modelCommand } from "./commands/model.js";
import { getPackageVersion } from "../utils/version.js";

export function createCLI(): Command {
  const program = new Command();

  program
    .name("swarm")
    .description("CLI swarm agent developer tool with multi-agent orchestration")
    .version(getPackageVersion());

  // register commands
  initCommand(program);
  runCommand(program);
  fixCommand(program);
  chatCommand(program);
  statusCommand(program);
  ollamaCommand(program);
  loginCommand(program);
  modelCommand(program);

  // default action: interactive chat when no subcommand is given
  program.action(async () => {
    const config = await loadConfig();
    if (!config) {
      console.log(chalk.red("No swarm configuration found. Run `swarm init` first."));
      process.exit(1);
    }
    await runChat(config);
  });

  return program;
}
