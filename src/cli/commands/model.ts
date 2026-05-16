import { Command } from "commander";
import { loadConfig, saveConfig } from "../../config/config.js";
import { OllamaProvider } from "../../providers/ollama.js";
import { OpenRouterProvider } from "../../providers/openrouter.js";
import { XiaomiProvider } from "../../providers/xiaomi.js";
import { logError, logInfo, logSuccess, logWarning } from "../../utils/logger.js";
import * as readline from "node:readline";
import chalk from "chalk";

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    console.error(prompt);
    rl.question("", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function modelCommand(program: Command): void {
  const model = program
    .command("model")
    .description("Manage model selection");

  // swarm model — interactive picker
  model
    .command("select")
    .description("Interactively select a model")
    .option("--base-url <url>", "API base URL")
    .option("--provider <provider>", "Provider to list models from")
    .action(async (options) => {
      const config = await loadConfig();
      if (!config) {
        logError("No swarm configuration found. Run `swarm init` first.");
        process.exit(1);
      }

      const providerName = options.provider || config.provider;
      const baseURL = options.baseUrl || config.baseURL;
      const apiKey = config.apiKey;

      let models: string[];
      try {
        if (providerName === "ollama") {
          const provider = new OllamaProvider({ baseURL });
          models = await provider.listModels();
        } else if (providerName === "openrouter") {
          const key = apiKey || process.env.OPENROUTER_API_KEY || "";
          if (!key) {
            logError("OpenRouter API key is required. Set OPENROUTER_API_KEY or use `swarm login`.");
            process.exit(1);
          }
          const provider = new OpenRouterProvider({ apiKey: key, baseURL: baseURL || "https://openrouter.ai/api/v1" });
          models = await provider.listModels();
        } else if (providerName === "xiaomi") {
          const key = apiKey || process.env.XIAOMI_API_KEY || "";
          const url = baseURL || process.env.XIAOMI_BASE_URL || "";
          if (!key || !url) {
            logError("Xiaomi API key and base URL are required.");
            process.exit(1);
          }
          const provider = new XiaomiProvider({ apiKey: key, baseURL: url });
          models = await provider.listModels();
        } else {
          logWarning(`Model selection is not supported for provider: ${providerName}`);
          return;
        }
      } catch (err) {
        logError(`Could not fetch models: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      if (models.length === 0) {
        logWarning("No models found.");
        return;
      }

      console.log(chalk.cyan(`\n📡 Fetching available models from ${providerName}...\n`));
      console.log(chalk.bold("🐝 Select a model:\n"));
      for (let i = 0; i < models.length; i++) {
        const marker = models[i] === config.model ? chalk.green(" ← current") : "";
        console.log(chalk.white(`  ${i + 1}) ${models[i]}${marker}`));
      }
      console.log();

      const answer = await ask(chalk.cyan(`  Enter number (1-${models.length}) or press Enter to cancel: `));

      if (!answer.trim()) {
        logInfo("Cancelled. No changes made.");
        return;
      }

      const index = parseInt(answer, 10) - 1;
      if (isNaN(index) || index < 0 || index >= models.length) {
        logError("Invalid selection.");
        process.exit(1);
      }

      const selected = models[index];
      config.model = selected;
      await saveConfig(config);
      logSuccess(`Model set to: ${selected}`);

      process.exit(0);
    });

  // swarm model show — show current model
  model
    .command("show")
    .description("Show the current model")
    .action(async () => {
      const config = await loadConfig();
      if (!config) {
        logError("No swarm configuration found. Run `swarm init` first.");
        process.exit(1);
      }

      console.log(`\n  Provider:  ${config.provider}`);
      console.log(`  Model:     ${chalk.bold(config.model)}`);
      if (config.baseURL) console.log(`  Base URL:  ${config.baseURL}`);
      console.log();

      process.exit(0);
    });

  // swarm model set <model> — set directly
  model
    .command("set <model>")
    .description("Set the model directly")
    .action(async (modelName: string) => {
      const config = await loadConfig();
      if (!config) {
        logError("No swarm configuration found. Run `swarm init` first.");
        process.exit(1);
      }

      config.model = modelName;
      await saveConfig(config);
      logSuccess(`Model set to: ${modelName}`);

      process.exit(0);
    });

  // swarm model list — list available models
  model
    .command("list")
    .description("List available models")
    .option("--base-url <url>", "API base URL")
    .option("--provider <provider>", "Provider to list models from")
    .action(async (options) => {
      const config = await loadConfig();
      const providerName = options.provider || config?.provider || "ollama";
      const baseURL = options.baseUrl || config?.baseURL;

      console.log(chalk.cyan(`\n📡 Fetching models from ${providerName}...\n`));

      let models: string[];
      try {
        if (providerName === "ollama") {
          const provider = new OllamaProvider({ baseURL: baseURL || "http://localhost:11434" });
          models = await provider.listModels();
        } else if (providerName === "openrouter") {
          const key = config?.apiKey || process.env.OPENROUTER_API_KEY || "";
          if (!key) {
            logError("OpenRouter API key is required. Set OPENROUTER_API_KEY or use `swarm login`.");
            process.exit(1);
          }
          const provider = new OpenRouterProvider({ apiKey: key, baseURL: baseURL || "https://openrouter.ai/api/v1" });
          models = await provider.listModels();
        } else if (providerName === "xiaomi") {
          const key = config?.apiKey || process.env.XIAOMI_API_KEY || "";
          const url = baseURL || process.env.XIAOMI_BASE_URL || "";
          if (!key || !url) {
            logError("Xiaomi API key and base URL are required.");
            process.exit(1);
          }
          const provider = new XiaomiProvider({ apiKey: key, baseURL: url });
          models = await provider.listModels();
        } else {
          logWarning(`Model listing is not supported for provider: ${providerName}`);
          return;
        }
      } catch (err) {
        logError(`Could not fetch models: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      if (models.length === 0) {
        logWarning("No models found.");
        return;
      }

      const currentModel = config?.model;
      console.log(chalk.bold("📦 Available models:\n"));
      for (const m of models) {
        const marker = m === currentModel ? chalk.green(" ← current") : "";
        console.log(`  • ${m}${marker}`);
      }
      console.log();

      process.exit(0);
    });
}
