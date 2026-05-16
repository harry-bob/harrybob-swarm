import { checkForUpdate } from "../../utils/version-check.js";
import { Command } from "commander";
import { runLogin } from "./login.js";
import { Orchestrator } from "../../core/orchestrator.js";
import { loadConfig, saveConfig } from "../../config/config.js";
import { loadSession } from "../../core/session.js";
import { promptInteractiveModelSelection } from "../model-picker.js";
import { TUI } from "../tui.js";
import { printBetaBanner } from "../../utils/beta-banner.js";
import chalk from "chalk";

export async function runChat(config: import("../../config/config.js").SwarmConfig, options?: { model?: string }): Promise<void> {
  if (options?.model) config.model = options.model;

  const tui = new TUI({
    model: config.model,
    provider: config.provider,
    onEnter: printBetaBanner,
  });

  // non-blocking version check — print inside TUI when ready
  checkForUpdate().then((update) => {
    if (update) {
      tui.printSystem("");
      tui.printSystem(
        chalk.hex("#FBBF24")(
          `  ⬆  Update available: ${update.current} → ${update.latest}`
        )
      );
      tui.printSystem(chalk.gray(`     Run: npm install -g @harrybob/swarm-cli`));
      tui.printSystem("");
    }
  }).catch(() => {});

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

        // Login
        if (tui.isLoginCommand(input)) {
          tui.suspend();
          try {
            await runLogin(config);
            tui.setModel(config.model);
            tui.setProvider(config.provider);
            tui.printSuccess(`Connected to ${config.provider} (${config.model})`);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            tui.printError(`Login failed: ${msg}`);
          } finally {
            tui.unsuspend();
          }
          continue;
        }

        // /model <name> — set model directly via slash command
        if (tui.isModelSetSlashCommand(input)) {
          const modelName = tui.parseModelSetSlashCommand(input);
          if (modelName) {
            config.model = modelName;
            await saveConfig(config);
            tui.setModel(config.model);
            tui.printSuccess(`Model set to: ${config.model}`);
          } else {
            tui.printError("Usage: /model <model-name>");
          }
          continue;
        }

        // Models
        if (tui.isModelsCommand(input)) {
          tui.suspend();
          try {
            const info = await promptInteractiveModelSelection(config);
            if (info) {
              config.provider = info.provider;
              config.model = info.id;
              if (info.baseURL) config.baseURL = info.baseURL;
              else delete config.baseURL;
              if (info.apiKey) config.apiKey = info.apiKey;
              else delete config.apiKey;
              await saveConfig(config);
              tui.setProvider(config.provider);
              tui.setModel(config.model);
              tui.printSuccess(`Switched to ${config.provider} (${config.model})`);
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            tui.printError(`Model selection failed: ${msg}`);
          } finally {
            tui.unsuspend();
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
              const done = result.completed.includes(st.id);
              const failed = result.failed.includes(st.id);
              const icon = done ? chalk.green("✅") : failed ? chalk.red("❌") : chalk.yellow("⬜");
              tui.printSystem(`${icon} ${st.id}: ${st.title}`);
            }
          }
          const durationSec = (result.duration / 1000).toFixed(1);
          const tu = result.tokenUsage;
          tui.printSystem(`⏱  ${durationSec}s │ 🔧 ${tu.prompt + tu.completion + tu.reasoning} tokens (in: ${tu.prompt}, out: ${tu.completion}, reasoning: ${tu.reasoning})`);
          tui.separator();
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          tui.printError(`Task failed: ${msg}`);
        }

        // spacing before next prompt
        tui.printSystem("");
      }

  tui.close();
  process.exit(0);
}

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
      await runChat(config, options);
    });
}
