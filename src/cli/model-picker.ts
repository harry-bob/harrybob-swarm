import * as readline from "node:readline";
import chalk from "chalk";
import { OllamaProvider } from "../providers/ollama.js";

interface ModelChoice {
  model: string;
  baseURL?: string;
}

export async function promptModelSelection(currentModel: string, baseURL?: string): Promise<ModelChoice> {
  console.log(chalk.cyan("\n📡 Fetching available models...\n"));

  let models: string[];
  try {
    const provider = new OllamaProvider({ baseURL });
    models = await provider.listModels();
  } catch {
    console.log(chalk.yellow("⚠ Could not connect to Ollama. Using default model."));
    return { model: currentModel, baseURL };
  }

  if (models.length === 0) {
    console.log(chalk.yellow("No models found. Using default."));
    return { model: currentModel, baseURL };
  }

  console.log(chalk.bold("🐝 Select a model:\n"));
  for (let i = 0; i < models.length; i++) {
    const marker = models[i] === currentModel ? chalk.green(" (current)") : "";
    console.log(chalk.white(`  ${i + 1}) ${models[i]}${marker}`));
  }
  console.log();

  const answer = await ask(chalk.cyan(`  Enter number (1-${models.length}) or press Enter for default [${currentModel}]: `));

  if (!answer.trim()) {
    console.log(chalk.gray(`  Using default: ${currentModel}`));
    return { model: currentModel, baseURL };
  }

  const index = parseInt(answer, 10) - 1;
  if (isNaN(index) || index < 0 || index >= models.length) {
    console.log(chalk.yellow(`  Invalid selection. Using default: ${currentModel}`));
    return { model: currentModel, baseURL };
  }

  const selected = models[index];
  console.log(chalk.green(`  ✓ Selected: ${selected}`));
  return { model: selected, baseURL };
}

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
