import chalk from "chalk";

/**
 * Terminal UI manager for an interactive chat-like experience.
 * Shows a persistent input prompt at the bottom, with all output scrolling above.
 */

const BANNER = `
${chalk.cyan("╔══════════════════════════════════════════════════════════════════╗")}
${chalk.cyan("║")}  ${chalk.bold("🐝 SWARM")} ${chalk.gray("— Interactive Mode")}                                  ${chalk.cyan("║")}
${chalk.cyan("╠══════════════════════════════════════════════════════════════════╣")}
${chalk.cyan("║")}  Type a task to create something                                ${chalk.cyan("║")}
${chalk.cyan("║")}  ${chalk.yellow("fix")} <issue>     — fix a bug from the previous task            ${chalk.cyan("║")}
${chalk.cyan("║")}  ${chalk.yellow("model select")}   — pick a model interactively                ${chalk.cyan("║")}
${chalk.cyan("║")}  ${chalk.yellow("model show")}     — show the current model                   ${chalk.cyan("║")}
${chalk.cyan("║")}  ${chalk.yellow("model set")} <m>  — set model directly                       ${chalk.cyan("║")}
${chalk.cyan("║")}  ${chalk.yellow("status")}         — show swarm configuration                  ${chalk.cyan("║")}
${chalk.cyan("║")}  ${chalk.yellow("clear")}           — clear the screen                         ${chalk.cyan("║")}
${chalk.cyan("║")}  ${chalk.yellow("exit")}            — exit interactive mode                    ${chalk.cyan("║")}
${chalk.cyan("╚══════════════════════════════════════════════════════════════════╝")}
`;

export interface TUIOptions {
  model: string;
  provider: string;
}

export class TUI {
  private model: string;
  private provider: string;

  constructor(options: TUIOptions) {
    this.model = options.model;
    this.provider = options.provider;
  }

  /**
   * Start the interactive terminal session.
   * Returns a generator that yields user inputs.
   */
  async *prompt(): AsyncGenerator<string, void, unknown> {
    this.setup();

    while (true) {
      const input = await this.getInput();
      if (input === null) break;
      yield input;
    }
  }

  /**
   * Set up the terminal for interactive mode.
   */
  private setup(): void {
    // Clear screen and show banner
    process.stdout.write("\x1b[2J\x1b[H");
    console.log(BANNER);
    this.printModelInfo();
    console.log();
  }

  private printModelInfo(): void {
    console.log(chalk.gray(`  Model: ${this.model}  │  Provider: ${this.provider}`));
  }

  /**
   * Update the displayed model.
   */
  setModel(model: string): void {
    this.model = model;
  }

  /**
   * Get a single line of input from the user.
   * In raw mode so multi-line pastes can be collapsed.
   * Returns null if the user wants to exit.
   */
  private getInput(): Promise<string | null> {
    return new Promise((resolve) => {
      const stdin = process.stdin;
      const stdout = process.stdout;

      let buffer = "";
      let pasteMode = false;
      let active = true;
      let lastDataTime = Date.now();

      const promptStr = chalk.green(chalk.bold("> "));

      const render = () => {
        if (!active) return;
        stdout.write("\r\x1b[2K");
        const hasNewlines = buffer.includes("\n") || buffer.includes("\r");
        if (pasteMode || hasNewlines) {
          const lines = buffer.split(/\r?\n/).length;
          const summary = lines > 1 ? `[pasted ${lines} lines]` : `[pasted ${buffer.length} chars]`;
          stdout.write(promptStr + chalk.gray(summary));
        } else {
          stdout.write(promptStr + buffer);
        }
      };

      const cleanup = () => {
        if (!active) return;
        active = false;
        if ("setRawMode" in stdin && typeof stdin.setRawMode === "function") {
          stdin.setRawMode(false);
        }
        stdout.write("\x1b[?2004l");
        stdin.pause();
        stdin.removeAllListeners("data");
        stdout.write("\n");
      };

      const onData = (data: string) => {
        if (!active) return;

        const now = Date.now();
        const timeSinceLastData = now - lastDataTime;
        lastDataTime = now;

        // Bracketed paste start (sent by modern terminals when the user pastes)
        if (data.startsWith("\x1b[200~")) {
          pasteMode = true;
          data = data.slice(6);
          if (!data) return;
        }

        // Bracketed paste end
        if (data.startsWith("\x1b[201~")) {
          data = data.slice(6);
          if (!data) return;
        }

        // Ignore other escape sequences (arrows, function keys, etc.)
        if (data.startsWith("\x1b")) {
          return;
        }

        // Enter / Return — distinguish pasted newlines from real Enter
        if (data === "\r" || data === "\n" || data === "\r\n") {
          // If bracketed-paste mode signalled a paste, or the newline arrived
          // very quickly after buffered data, treat it as part of a paste.
          if (pasteMode || (buffer.length > 0 && timeSinceLastData < 100)) {
            pasteMode = true;
            buffer += "\n";
            render();
            return;
          }
          cleanup();
          resolve(buffer.trim());
          return;
        }

        // Ctrl+C
        if (data === "\x03") {
          cleanup();
          process.exit(0);
        }

        // Ctrl+D (EOF)
        if (data === "\x04") {
          cleanup();
          resolve(null);
          return;
        }

        // Detect paste heuristically: multi-line or large chunk
        const hasNewline = data.includes("\n") || data.includes("\r");
        if ((hasNewline && data.length > 1) || data.length > 5) {
          pasteMode = true;
        }

        for (let i = 0; i < data.length; i++) {
          const code = data.charCodeAt(i);

          // Backspace / Delete
          if (code === 127 || code === 8) {
            if (buffer.length > 0) {
              buffer = buffer.slice(0, -1);
              if (buffer.length === 0) {
                pasteMode = false;
              }
            }
            continue;
          }

          // Tab
          if (code === 9) {
            buffer += "\t";
            continue;
          }

          // Normalize any pasted newlines to \n
          if (code === 10 || code === 13) {
            buffer += "\n";
            continue;
          }

          // Skip other control characters
          if (code < 32) {
            continue;
          }

          buffer += data[i];
        }

        render();
      };

      if ("setRawMode" in stdin && typeof stdin.setRawMode === "function") {
        stdin.setRawMode(true);
      }
      stdin.resume();
      stdin.setEncoding("utf8");
      stdin.on("data", onData);

      // Enable bracketed paste mode
      stdout.write("\x1b[?2004h");
      stdout.write(promptStr);
    });
  }

  /**
   * Close the TUI and clean up.
   */
  close(): void {
    console.log(chalk.gray("\n  Goodbye! 🐝\n"));
  }

  /**
   * Print a separator line.
   */
  separator(): void {
    console.log(chalk.gray("─".repeat(64)));
  }

  /**
   * Print a user message.
   */
  printUser(message: string): void {
    console.log();
    console.log(chalk.green(chalk.bold("  You: ")) + chalk.white(message));
    console.log();
  }

  /**
   * Print a system message.
   */
  printSystem(message: string): void {
    console.log(chalk.gray(`  ${message}`));
  }

  /**
   * Print an error message.
   */
  printError(message: string): void {
    console.log(chalk.red(`  ✗ ${message}`));
  }

  /**
   * Print a success message.
   */
  printSuccess(message: string): void {
    console.log(chalk.green(`  ✓ ${message}`));
  }

  /**
   * Print an info message.
   */
  printInfo(message: string): void {
    console.log(chalk.blue(`  ℹ ${message}`));
  }

  /**
   * Print a divider between tasks.
   */
  divider(): void {
    console.log();
    console.log(chalk.gray("  " + "─".repeat(60)));
    console.log();
  }

  /**
   * Clear the screen and re-show the banner.
   */
  clear(): void {
    process.stdout.write("\x1b[2J\x1b[H");
    console.log(BANNER);
    this.printModelInfo();
    console.log();
  }

  /**
   * Check if input is an exit command.
   */
  isExit(input: string): boolean {
    return ["exit", "quit", "q", "bye"].includes(input.toLowerCase());
  }

  /**
   * Check if input is a clear command.
   */
  isClear(input: string): boolean {
    return input.toLowerCase() === "clear";
  }

  /**
   * Check if input is a status command.
   */
  isStatus(input: string): boolean {
    return input.toLowerCase() === "status";
  }

  /**
   * Check if input is a model command.
   */
  isModelCommand(input: string): boolean {
    return input.toLowerCase().startsWith("model");
  }

  /**
   * Parse the model command.
   */
  parseModelCommand(input: string): { action: string; arg?: string } {
    const parts = input.toLowerCase().split(/\s+/);
    return {
      action: parts[1] || "show",
      arg: parts[2],
    };
  }

  /**
   * Check if input is a fix command.
   */
  isFixCommand(input: string): boolean {
    return input.toLowerCase().startsWith("fix ") || input.toLowerCase().startsWith("fix:");
  }

  /**
   * Parse the fix command to extract the issue description.
   */
  parseFixCommand(input: string): string {
    return input.replace(/^fix\s*:?\s*/i, "").trim();
  }

  /**
   * Check if input is a help command.
   */
  isHelp(input: string): boolean {
    return ["help", "?", "h"].includes(input.toLowerCase());
  }

  /**
   * Print help information.
   */
  printHelp(): void {
    console.log();
    console.log(chalk.bold("  Commands:"));
    console.log(chalk.yellow("    <task>") + "              — Run a new task (e.g., 'create a calculator app')");
    console.log(chalk.yellow("    fix <issue>") + "         — Fix a bug from the previous task");
    console.log(chalk.yellow("    model select") + "        — Pick a model interactively");
    console.log(chalk.yellow("    model show") + "          — Show the current model");
    console.log(chalk.yellow("    model set <name>") + "    — Set model directly");
    console.log(chalk.yellow("    status") + "              — Show swarm configuration");
    console.log(chalk.yellow("    clear") + "               — Clear the screen");
    console.log(chalk.yellow("    help") + "                — Show this help");
    console.log(chalk.yellow("    exit") + "                — Exit interactive mode");
    console.log();
  }
}
