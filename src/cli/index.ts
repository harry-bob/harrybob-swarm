import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { fixCommand } from "./commands/fix.js";
import { statusCommand } from "./commands/status.js";
import { ollamaCommand } from "./commands/ollama.js";
import { chatCommand } from "./commands/chat.js";
import { modelCommand } from "./commands/model.js";

export function createCLI(): Command {
  const program = new Command();

  program
    .name("swarm")
    .description("CLI swarm agent developer tool with multi-agent orchestration")
    .version("0.1.0");

  // Register commands
  initCommand(program);
  runCommand(program);
  fixCommand(program);
  chatCommand(program);
  statusCommand(program);
  ollamaCommand(program);
  modelCommand(program);

  return program;
}
