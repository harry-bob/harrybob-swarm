import * as readline from "node:readline";
import chalk from "chalk";
import { OllamaProvider } from "../providers/ollama.js";
import { OpenAIProvider } from "../providers/openai.js";
import type { SwarmConfig } from "../config/config.js";

export interface ModelInfo {
  id: string;
  provider: string;
  baseURL?: string;
  apiKey?: string;
}

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

/**
 * Fetch models from ALL available providers (Ollama + OpenAI).
 * Returns a combined list where each entry knows its provider.
 */
async function fetchAllModels(config: SwarmConfig): Promise<ModelInfo[]> {
  const results: ModelInfo[] = [];

  // ── Ollama ────────────────────────────────────────────────
  const ollamaURL = config.baseURL || process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  try {
    const ollama = new OllamaProvider({ baseURL: ollamaURL });
    const models = await ollama.listModels();
    for (const m of models) {
      results.push({ id: m, provider: "ollama", baseURL: ollamaURL });
    }
  } catch {
    // silently skip if Ollama isn't running
  }

  // ── OpenAI ──────────────────────────────────────────────
  const openaiKey = config.apiKey || process.env.OPENAI_API_KEY || "";
  const openaiURL = config.baseURL || "https://api.openai.com/v1";
  if (openaiKey) {
    try {
      const openai = new OpenAIProvider(openaiKey, openaiURL);
      const models = await openai.listModels();
      for (const m of models) {
        results.push({ id: m, provider: "openai", baseURL: openaiURL, apiKey: openaiKey });
      }
    } catch {
      // silently skip if key is invalid
    }
  }

  return results;
}

/**
 * Interactive arrow-key model picker.
 * Displays models from ALL available providers.
 * Returns full ModelInfo so the caller knows which provider to switch to.
 */
export async function promptInteractiveModelSelection(config: SwarmConfig): Promise<ModelInfo | null> {
  console.log(chalk.cyan("\n📡 Fetching available models from all providers...\n"));

  const all = await fetchAllModels(config);

  if (all.length === 0) {
    console.log(chalk.yellow("  No models found. Make sure Ollama is running or an OpenAI API key is set."));
    return null;
  }

  const currentFullId = `${config.provider}/${config.model}`;
  const labels = all.map((m) => `${m.provider}/${m.id}`);
  const currentIdx = labels.indexOf(currentFullId);

  // dedupe labels that collide (rare but possible)
  const seen = new Set<string>();
  for (let i = 0; i < labels.length; i++) {
    if (seen.has(labels[i])) {
      let suffix = 2;
      while (seen.has(`${labels[i]} (${suffix})`)) suffix++;
      labels[i] = `${labels[i]} (${suffix})`;
    }
    seen.add(labels[i]);
  }

  const title = `🐝 ${all.length} model(s) found (↑↓ to navigate, Enter to confirm, Esc to cancel):`;
  const selectedIdx = await pickFromListIdx(labels, currentIdx >= 0 ? currentIdx : 0, title, (label, i) => {
    const m = all[i];
    const providerColor = m.provider === "ollama" ? chalk.blue : chalk.magenta;
    return providerColor(`  ${m.provider.padEnd(7)} `) + m.id;
  });

  if (selectedIdx === null) return null;

  const selected = all[selectedIdx];
  console.log(chalk.green(`\n  ✓ Selected: ${selected.provider}/${selected.id}`));
  return selected;
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

/** Simple arrow-key list picker. Runs in raw terminal mode. Returns the index. */
async function pickFromListIdx(
  items: string[],
  startIndex = 0,
  title?: string,
  renderItem?: (label: string, index: number) => string
): Promise<number | null> {
  return new Promise((resolve) => {
    let selected = Math.max(0, Math.min(startIndex, items.length - 1));

    const stdin = process.stdin;
    const wasRaw = "setRawMode" in stdin && typeof stdin.setRawMode === "function" ? stdin.isRaw : false;

    if ("setRawMode" in stdin && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
    }
    stdin.resume();

    const onData = (data: Buffer) => {
      const key = data.toString();
      if (key === "\x1b[A") {
        selected = Math.max(0, selected - 1);
        redraw();
      } else if (key === "\x1b[B") {
        selected = Math.min(items.length - 1, selected + 1);
        redraw();
      } else if (key === "\r" || key === "\n") {
        cleanup();
        resolve(selected);
      } else if (key === "\x1b" || key === "\x03") {
        cleanup();
        resolve(null);
      }
    };

    const cleanup = () => {
      stdin.removeListener("data", onData);
      if ("setRawMode" in stdin && typeof stdin.setRawMode === "function") {
        stdin.setRawMode(wasRaw);
      }
      stdin.pause();
    };

    function drawLine(label: string, i: number) {
      const prefix = i === selected ? chalk.green("  > ") : "     ";
      const text = renderItem ? renderItem(label, i) : i === selected ? chalk.bold(label) : chalk.gray(label);
      return `${prefix}${text}\n`;
    }

    function draw() {
      if (title) process.stdout.write(chalk.cyan(title) + "\n");
      items.forEach((item, i) => {
        process.stdout.write(drawLine(item, i));
      });
    }

    function redraw() {
      process.stdout.write(`\x1b[${items.length + (title ? 1 : 0)}A`);
      if (title) {
        process.stdout.write("\x1b[2K");
        process.stdout.write(chalk.cyan(title) + "\n");
      }
      items.forEach((item, i) => {
        process.stdout.write(`\x1b[2K${drawLine(item, i)}`);
      });
    }

    stdin.on("data", onData);
    draw();
  });
}
