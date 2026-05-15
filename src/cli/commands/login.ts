import { Command } from "commander";
import { loadConfig, saveConfig, SwarmConfig } from "../../config/config.js";
import { createProvider } from "../../providers/factory.js";
import { OllamaProvider } from "../../providers/ollama.js";
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

export async function runLogin(config: SwarmConfig): Promise<void> {
  console.log(chalk.cyan("\n🔐 Provider Login\n"));

  console.log(chalk.bold("Select provider:"));
  console.log("  1) OpenAI");
  console.log("  2) Ollama");
  console.log();

  const choice = await ask(chalk.cyan("  Enter number (1-2): "));

  if (choice === "1") {
    await loginOpenAI(config);
  } else if (choice === "2") {
    await loginOllama(config);
  } else {
    console.log(chalk.yellow("  Cancelled."));
  }
}

async function loginOpenAI(config: SwarmConfig): Promise<void> {
  const apiKey = await ask(chalk.cyan("  Enter OpenAI API key (or press Enter to keep current): "));
  const model = await ask(chalk.cyan("  Enter model (default: gpt-4o): "));
  const baseURL = await ask(chalk.cyan("  Enter base URL (default: https://api.openai.com/v1): "));

  if (apiKey) {
    process.env.OPENAI_API_KEY = apiKey;
    config.apiKey = apiKey;
  }

  config.provider = "openai";
  config.model = model || "gpt-4o";
  if (baseURL) {
    config.baseURL = baseURL;
  } else {
    delete config.baseURL;
  }

  // Test connection
  try {
    const url = config.baseURL || "https://api.openai.com/v1";
    const key = config.apiKey || process.env.OPENAI_API_KEY || "";
    if (!key) {
      console.log(chalk.yellow("  ⚠ No API key provided. Set OPENAI_API_KEY before running."));
    } else {
      const res = await fetch(`${url}/models`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      console.log(chalk.green("  ✓ Connection test passed"));
    }
  } catch (err) {
    console.log(chalk.yellow(`  ⚠ Connection test failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  await saveConfig(config);
  console.log(chalk.green(`  ✓ Config saved. Provider: openai, Model: ${config.model}`));
}

async function loginOllama(config: SwarmConfig): Promise<void> {
  const baseURL = await ask(chalk.cyan("  Enter Ollama base URL (default: http://localhost:11434): "));
  const url = baseURL || "http://localhost:11434";

  let models: string[];
  try {
    const provider = new OllamaProvider({ baseURL: url });
    models = await provider.listModels();
    console.log(chalk.green(`  ✓ Connected. Found ${models.length} model(s).`));
  } catch (err) {
    console.log(chalk.red(`  ✗ Could not connect to Ollama at ${url}`));
    console.log(chalk.gray(`    ${err instanceof Error ? err.message : String(err)}`));
    return;
  }

  if (models.length === 0) {
    console.log(chalk.yellow("  No models found. Pull one with: ollama pull <model>"));
    return;
  }

  console.log(chalk.bold("\n  Available models:"));
  for (let i = 0; i < models.length; i++) {
    const marker = models[i] === config.model ? chalk.green(" (current)") : "";
    console.log(`    ${i + 1}) ${models[i]}${marker}`);
  }
  console.log();

  const answer = await ask(chalk.cyan(`  Enter number (1-${models.length}) or press Enter to keep [${config.model}]: `));
  let selected = config.model;
  if (answer) {
    const idx = parseInt(answer, 10) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < models.length) {
      selected = models[idx];
    }
  }

  config.provider = "ollama";
  config.model = selected;
  config.baseURL = url;
  delete config.apiKey;

  await saveConfig(config);
  console.log(chalk.green(`  ✓ Config saved. Provider: ollama, Model: ${selected}`));
}

export function loginCommand(program: Command): void {
  program
    .command("login")
    .description("Log in to a provider interactively")
    .action(async () => {
      const config = await loadConfig();
      if (!config) {
        console.log(chalk.red("No swarm configuration found. Run `swarm init` first."));
        process.exit(1);
      }
      await runLogin(config);
      process.exit(0);
    });
}
