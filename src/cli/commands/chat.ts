import { Command } from "commander";
import { Orchestrator } from "../../core/orchestrator.js";
import { loadConfig, saveConfig } from "../../config/config.js";
import { loadSession } from "../../core/session.js";
import { promptModelSelection } from "../model-picker.js";
import { TUI } from "../tui.js";
import chalk from "chalk";

export function chatCommand(program: Command): void {
  program
    .command("chat")
    .description("Start an interactive chat session")
    .option("--model <model>", "Override model")

    .action(async (options) => {
      const config = await loadConfig();
      if (!config) {
        console.log(chalk.red("No swarm configuration found. Run `swarm init` first."));
        process.exit(1);
      }

      if (options.model) config.model = options.model;

      const tui = new TUI({
        model: config.model,
        provider: config.provider,
      });



      for await (const input of tui.prompt()) {
        // Skip empty input
        if (!input) continue;

        // Exit
        if (tui.isExit(input)) {
          tui.close();
          process.exit(0);
        }

        // Clear
        if (tui.isClear(input)) {
          tui.clear();
          continue;
        }

        // Help
        if (tui.isHelp(input)) {
          tui.printHelp();
          continue;
        }

        // Status
        if (tui.isStatus(input)) {
          tui.separator();
          tui.printInfo(`Model: ${chalk.bold(config.model)}`);
          tui.printInfo(`Provider: ${config.provider}`);
          if (config.baseURL) tui.printInfo(`Base URL: ${config.baseURL}`);

          const session = await loadSession();
          if (session) {
            tui.printInfo(`Last task: ${session.lastTask.slice(0, 60)}...`);
            tui.printInfo(`Files: ${session.filesCreated.join(", ")}`);
          }
          tui.separator();
          continue;
        }

        // Model commands
        if (tui.isModelCommand(input)) {
          const cmd = tui.parseModelCommand(input);
          switch (cmd.action) {
            case "select": {
              const choice = await promptModelSelection(config.model, config.baseURL);
              config.model = choice.model;
              if (choice.baseURL) config.baseURL = choice.baseURL;
              await saveConfig(config);
              tui.setModel(config.model);
              tui.printSuccess(`Model set to: ${config.model}`);
              break;
            }
            case "set": {
              if (cmd.arg) {
                config.model = cmd.arg;
                await saveConfig(config);
                tui.setModel(config.model);
                tui.printSuccess(`Model set to: ${config.model}`);
              } else {
                tui.printError("Usage: model set <model-name>");
              }
              break;
            }
            case "show":
              tui.printInfo(`Current model: ${chalk.bold(config.model)}`);
              break;
            default:
              tui.printError("Unknown model command. Use: model select, model set <name>, model show");
          }
          continue;
        }

        // ── Run or Fix ──────────────────────────────────────────
        tui.separator();
        tui.printUser(input);

        let taskDescription: string;

        if (tui.isFixCommand(input)) {
          // Fix command — load previous session context
          const issue = tui.parseFixCommand(input);
          const session = await loadSession();
          const contextHint = session
            ? `\n\nPrevious task: "${session.lastTask}"\nFiles created: ${session.filesCreated.join(", ")}\nPlan: ${session.lastPlan || "N/A"}\n\nThe user is reporting a bug or issue with the previous output. Investigate the existing code, find the problem, and fix it.`
            : "";
          taskDescription = `FIX/DEBUG REQUEST: ${issue}${contextHint}`;
          if (session) {
            tui.printSystem(`Using context from: ${session.lastTask.slice(0, 60)}...`);
          }
        } else {
          // Regular task
          taskDescription = input;
        }

        // Create orchestrator with current config
        const orchestrator = new Orchestrator(config);

        try {
          const result = await orchestrator.run(taskDescription, {

          });

          // Show result summary
          tui.divider();
          if (result.plan) {
            for (const st of result.plan.subtasks) {
              const done = result.output.includes(st.id) || result.output.includes(st.title);
              const icon = done ? chalk.green("✅") : chalk.red("❌");
              tui.printSystem(`${icon} ${st.id}: ${st.title}`);
            }
          }
          const durationSec = (result.duration / 1000).toFixed(1);
          tui.printSystem(`⏱  ${durationSec}s │ 🔧 ${result.tokenUsage.prompt + result.tokenUsage.completion} tokens`);
          tui.separator();
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          tui.printError(`Task failed: ${msg}`);
        }

        console.log();
      }

      tui.close();
    });
}
