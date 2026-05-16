import * as readline from "node:readline";
import chalk from "chalk";
import { OllamaProvider } from "../providers/ollama.js";
import { OpenAIProvider } from "../providers/openai.js";
import { OpenRouterProvider } from "../providers/openrouter.js";
import { XiaomiProvider } from "../providers/xiaomi.js";
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
 * Fetch models from ALL available providers.
 * Returns a combined list where each entry knows its provider.
 */
async function fetchAllModels(config: SwarmConfig): Promise<ModelInfo[]> {
  const results: ModelInfo[] = [];

  // ── Ollama ────────────────────────────────────────────────
  const ollamaURL = config.provider === "ollama"
    ? (config.baseURL || process.env.OLLAMA_BASE_URL || "http://localhost:11434")
    : (process.env.OLLAMA_BASE_URL || "http://localhost:11434");
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
  // Only use config.baseURL/config.apiKey if the current provider is openai;
  // otherwise we risk calling another provider's endpoint with openai credentials.
  const openaiKey = config.provider === "openai"
    ? (config.apiKey || process.env.OPENAI_API_KEY || "")
    : (process.env.OPENAI_API_KEY || "");
  const openaiURL = config.provider === "openai"
    ? (config.baseURL || "https://api.openai.com/v1")
    : "https://api.openai.com/v1";
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

  // ── OpenRouter ──────────────────────────────────────────
  const openrouterKey = config.provider === "openrouter"
    ? (config.apiKey || process.env.OPENROUTER_API_KEY || "")
    : (process.env.OPENROUTER_API_KEY || "");
  const openrouterURL = config.provider === "openrouter"
    ? (config.baseURL || "https://openrouter.ai/api/v1")
    : "https://openrouter.ai/api/v1";
  if (openrouterKey) {
    try {
      const openrouter = new OpenRouterProvider({ apiKey: openrouterKey, baseURL: openrouterURL });
      const models = await openrouter.listModels();
      for (const m of models) {
        results.push({ id: m, provider: "openrouter", baseURL: openrouterURL, apiKey: openrouterKey });
      }
    } catch {
      // silently skip if key is invalid
    }
  }

  // ── Xiaomi ──────────────────────────────────────────────
  const xiaomiKey = config.provider === "xiaomi"
    ? (config.apiKey || process.env.XIAOMI_API_KEY || "")
    : (process.env.XIAOMI_API_KEY || "");
  const xiaomiURL = config.provider === "xiaomi"
    ? (config.baseURL || process.env.XIAOMI_BASE_URL || "")
    : (process.env.XIAOMI_BASE_URL || "");
  if (xiaomiKey && xiaomiURL) {
    try {
      const xiaomi = new XiaomiProvider({ apiKey: xiaomiKey, baseURL: xiaomiURL });
      const models = await xiaomi.listModels();
      for (const m of models) {
        results.push({ id: m, provider: "xiaomi", baseURL: xiaomiURL, apiKey: xiaomiKey });
      }
    } catch {
      // silently skip
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
    console.log(chalk.yellow("  No models found. Make sure your provider is configured (Ollama running, or API keys set)."));
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

  const title = `🐝 ${all.length} model(s) found (↑↓ navigate, Enter confirm, Esc cancel, type to filter):`;
  const selectedIdx = await pickFromListIdx(labels, currentIdx >= 0 ? currentIdx : 0, title, (label, i) => {
    const m = all[i];
    const providerColors: Record<string, (s: string) => string> = {
      ollama: chalk.blue,
      openai: chalk.magenta,
      openrouter: chalk.yellow,
      xiaomi: chalk.cyan,
    };
    const providerColor = providerColors[m.provider] || chalk.gray;
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

/** Interactive arrow-key list picker with viewport scrolling and live filtering.
 *  Displays at most VIEWPORT_SIZE items at a time.
 *  ↑↓ to navigate, type to filter, Enter to confirm, Esc to cancel, Ctrl+U to clear filter.
 */
async function pickFromListIdx(
  items: string[],
  startIndex = 0,
  title?: string,
  renderItem?: (label: string, index: number) => string
): Promise<number | null> {
  return new Promise((resolve) => {
    const VIEWPORT_SIZE = 20;
    let selected = Math.max(0, Math.min(startIndex, items.length - 1));
    let scrollTop = 0;
    let filter = "";
    let filteredIndices: number[] = items.map((_, i) => i);
    let lastDrawnLines = 0;

    const stdin = process.stdin;
    const wasRaw = "setRawMode" in stdin && typeof stdin.setRawMode === "function" ? stdin.isRaw : false;

    if ("setRawMode" in stdin && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding("utf8");

    function applyFilter() {
      if (!filter) {
        filteredIndices = items.map((_, i) => i);
      } else {
        const f = filter.toLowerCase();
        filteredIndices = [];
        for (let i = 0; i < items.length; i++) {
          if (items[i].toLowerCase().includes(f)) {
            filteredIndices.push(i);
          }
        }
      }
      selected = Math.min(selected, Math.max(0, filteredIndices.length - 1));
      scrollTop = 0;
      clampScroll();
    }

    function clampScroll() {
      if (filteredIndices.length === 0) {
        scrollTop = 0;
        return;
      }
      if (selected < scrollTop) {
        scrollTop = selected;
      } else if (selected >= scrollTop + VIEWPORT_SIZE) {
        scrollTop = selected - VIEWPORT_SIZE + 1;
      }
      const maxScroll = Math.max(0, filteredIndices.length - VIEWPORT_SIZE);
      scrollTop = Math.max(0, Math.min(scrollTop, maxScroll));
    }

    function moveUp() {
      if (selected > 0) {
        selected--;
        clampScroll();
        redraw();
      }
    }

    function moveDown() {
      if (selected < filteredIndices.length - 1) {
        selected++;
        clampScroll();
        redraw();
      }
    }

    function drawLine(fi: number): string {
      const origIdx = filteredIndices[fi];
      const label = items[origIdx];
      const isSelected = fi === selected;
      const prefix = isSelected ? chalk.green("  > ") : "     ";
      const text = renderItem
        ? renderItem(label, origIdx)
        : isSelected
        ? chalk.bold(label)
        : chalk.gray(label);
      return `\x1b[2K${prefix}${text}`;
    }

    function draw() {
      const headerLines: string[] = [];
      if (title) headerLines.push(`\x1b[2K${chalk.cyan(title)}`);

      const filterDisplay = filter
        ? chalk.white(filter) + chalk.gray("_")
        : chalk.gray("(type to search)");
      headerLines.push(`\x1b[2K  Filter: ${filterDisplay}`);

      const bodyLines: string[] = [];
      if (filteredIndices.length === 0) {
        bodyLines.push(`\x1b[2K${chalk.yellow("  (no matches)")}`);
      } else {
        const visibleCount = Math.min(VIEWPORT_SIZE, filteredIndices.length);
        for (let v = 0; v < visibleCount; v++) {
          bodyLines.push(drawLine(scrollTop + v));
        }
      }

      // Pad remaining viewport lines with empty clears so redraw cursor math is constant
      while (bodyLines.length < VIEWPORT_SIZE) {
        bodyLines.push("\x1b[2K");
      }

      lastDrawnLines = headerLines.length + bodyLines.length;
      process.stdout.write([...headerLines, ...bodyLines].join("\n") + "\n");
    }

    function redraw() {
      if (lastDrawnLines > 0) {
        process.stdout.write(`\x1b[${lastDrawnLines}A`);
      }
      draw();
    }

    function cleanup() {
      stdin.removeListener("data", onData);
      if ("setRawMode" in stdin && typeof stdin.setRawMode === "function") {
        stdin.setRawMode(wasRaw);
      }
      stdin.pause();
      process.stdout.write("\x1b[?25h"); // show cursor
    }

    const onData = (raw: Buffer | string) => {
      const str = typeof raw === "string" ? raw : raw.toString("utf-8");
      let i = 0;
      while (i < str.length) {
        const ch = str[i];
        const code = str.charCodeAt(i);

        // Escape sequences
        if (ch === "\x1b") {
          if (str.slice(i, i + 3) === "\x1b[A") {
            moveUp();
            i += 3;
            continue;
          }
          if (str.slice(i, i + 3) === "\x1b[B") {
            moveDown();
            i += 3;
            continue;
          }
          // Other CSI sequences: skip until final byte
          let j = i + 1;
          while (
            j < str.length &&
            (str[j] === "[" ||
              str[j] === "(" ||
              str[j] === ")" ||
              (str.charCodeAt(j) >= 0x30 && str.charCodeAt(j) <= 0x3f) ||
              (str.charCodeAt(j) >= 0x20 && str.charCodeAt(j) <= 0x2f))
          ) {
            j++;
          }
          if (j < str.length) j++;
          if (j === i + 1) {
            // Lone ESC
            cleanup();
            resolve(null);
            return;
          }
          i = j;
          continue;
        }

        // Enter
        if (ch === "\r" || ch === "\n") {
          cleanup();
          resolve(filteredIndices.length === 0 ? null : filteredIndices[selected]);
          return;
        }

        // Ctrl+C
        if (code === 3) {
          cleanup();
          resolve(null);
          return;
        }

        // Backspace / Delete
        if (code === 127 || code === 8) {
          if (filter.length > 0) {
            filter = filter.slice(0, -1);
            applyFilter();
            redraw();
          }
          i++;
          continue;
        }

        // Ctrl+U — clear filter
        if (code === 21) {
          filter = "";
          applyFilter();
          redraw();
          i++;
          continue;
        }

        // Skip other control chars
        if (code < 32) {
          i++;
          continue;
        }

        // Printable
        filter += ch;
        applyFilter();
        redraw();
        i++;
      }
    };

    process.stdout.write("\x1b[?25l"); // hide cursor
    applyFilter();
    draw();
    stdin.on("data", onData);
  });
}
