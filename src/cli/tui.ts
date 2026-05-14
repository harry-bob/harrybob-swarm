import chalk from "chalk";

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

/**
 * Chat-style terminal UI.
 *
 * Uses the alternate screen buffer so the normal terminal scrollback is
 * untouched.  All stdout / stderr output produced while the TUI is active
 * is captured and rendered in the history area above the input box.
 */
export class TUI {
  private model: string;
  private provider: string;

  // ── screen state ────────────────────────────────────────────
  private active = false;           // TUI is in alternate screen
  private suspended = false;        // temporarily bypass interception
  private buffer: string[] = [];      // complete lines of chat history
  private pendingLine = "";          // incomplete line (streaming)
  private inputBuffer = "";          // what the user is currently typing
  private pasteMode = false;         // bracketed-paste or heuristic paste
  private scrollOffset = 0;        // lines scrolled up from bottom

  // ── input state ─────────────────────────────────────────────
  private inputMode: "input" | "output" | "external" = "output";
  private inputResolve: ((value: string | null) => void) | null = null;
  private savedMode: "input" | "output" | null = null;

  // ── original I/O hooks ─────────────────────────────────────
  private origStdoutWrite: typeof process.stdout.write;
  private origStderrWrite: typeof process.stderr.write;

  // ── render throttling ────────────────────────────────────────
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private isRendering = false;
  private readonly RENDER_FPS = 30; // ~33 ms

  constructor(options: TUIOptions) {
    this.model = options.model;
    this.provider = options.provider;

    // re-render on terminal resize
    process.stdout.on("resize", () => {
      if (this.active) this.scheduleRender();
    });

    // allow external interactive prompts (e.g. ask_user_question) to
    // suspend / resume the TUI cleanly
    const self = this;
    process.on("swarm::interactivePromptStart" as any, () => {
      if (self.active) self.suspend();
    });
    process.on("swarm::interactivePromptEnd" as any, () => {
      if (self.suspended) self.unsuspend();
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════════════════════

  /**
   * Start the interactive terminal session.
   * Returns a generator that yields user inputs.
   */
  async *prompt(): AsyncGenerator<string, void, unknown> {
    this.enter();
    this.startStdin();
    while (true) {
      const input = await this.readInput();
      if (input === null) break;
      yield input;
    }
    this.leave();
  }

  setModel(model: string): void {
    this.model = model;
  }

  close(): void {
    // goodbye is drawn by leave()
  }

  clear(): void {
    this.buffer = [];
    this.pendingLine = "";
    this.scrollOffset = 0;
    this.printBanner();
    this.printModelInfo();
    this.scheduleRender();
  }

  // ── styled chat messages ───────────────────────────────────
  printUser(message: string): void {
    this.addOutput("\n" + chalk.green(chalk.bold("You: ")) + chalk.white(message) + "\n");
  }

  printSystem(message: string): void {
    this.addOutput(chalk.gray(`  ${message}`) + "\n");
  }

  printError(message: string): void {
    this.addOutput(chalk.red(`  ✗ ${message}`) + "\n");
  }

  printSuccess(message: string): void {
    this.addOutput(chalk.green(`  ✓ ${message}`) + "\n");
  }

  printInfo(message: string): void {
    this.addOutput(chalk.blue(`  ℹ ${message}`) + "\n");
  }

  separator(): void {
    this.addOutput(chalk.gray("─".repeat(64)) + "\n");
  }

  divider(): void {
    this.addOutput("\n" + chalk.gray("  " + "─".repeat(60)) + "\n");
  }

  printHelp(): void {
    this.addOutput("\n" + chalk.bold("  Commands:") + "\n");
    this.addOutput(chalk.yellow("    <task>") + "              — Run a new task\n");
    this.addOutput(chalk.yellow("    fix <issue>") + "         — Fix a bug from the previous task\n");
    this.addOutput(chalk.yellow("    model select") + "        — Pick a model interactively\n");
    this.addOutput(chalk.yellow("    model show") + "          — Show the current model\n");
    this.addOutput(chalk.yellow("    model set <name>") + "    — Set model directly\n");
    this.addOutput(chalk.yellow("    status") + "              — Show swarm configuration\n");
    this.addOutput(chalk.yellow("    clear") + "               — Clear the screen\n");
    this.addOutput(chalk.yellow("    help") + "                — Show this help\n");
    this.addOutput(chalk.yellow("    exit") + "                — Exit interactive mode\n");
    this.addOutput("\n");
  }

  // ── input classification (unchanged API) ───────────────────
  isExit(input: string): boolean {
    return ["exit", "quit", "q", "bye"].includes(input.toLowerCase());
  }

  isClear(input: string): boolean {
    return input.toLowerCase() === "clear";
  }

  isStatus(input: string): boolean {
    return input.toLowerCase() === "status";
  }

  isModelCommand(input: string): boolean {
    return input.toLowerCase().startsWith("model");
  }

  parseModelCommand(input: string): { action: string; arg?: string } {
    const parts = input.toLowerCase().split(/\s+/);
    return { action: parts[1] || "show", arg: parts[2] };
  }

  isFixCommand(input: string): boolean {
    return input.toLowerCase().startsWith("fix ") || input.toLowerCase().startsWith("fix:");
  }

  parseFixCommand(input: string): string {
    return input.replace(/^fix\s*:?\s*/i, "").trim();
  }

  isHelp(input: string): boolean {
    return ["help", "?", "h"].includes(input.toLowerCase());
  }

  // ═══════════════════════════════════════════════════════════
  //  Lifecycle
  // ═══════════════════════════════════════════════════════════

  /** Enter the alternate screen buffer and start capturing output. */
  private enter(): void {
    process.stdout.write("\x1b[?1049h");   // alternate screen
    process.stdout.write("\x1b[2J\x1b[H");   // clear & home
    this.active = true;
    this.hijackOutput();
    this.printBanner();
    this.printModelInfo();
    this.scheduleRender();
  }

  /** Restore normal terminal screen and stop capturing. */
  private leave(): void {
    this.addOutput(chalk.gray("\n  Goodbye! 🐝\n"));
    this.render(true);

    this.stopStdin();
    this.active = false;
    this.restoreOutput();
    process.stdout.write("\x1b[?1049l");   // normal screen
  }

  /**
   * Suspend interception so external interactive prompts
   * (e.g. model picker) can write directly to the terminal.
   */
  suspend(): void {
    if (!this.active) return;

    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }

    this.savedMode = this.inputMode;
    this.inputMode = "external";
    this.stopStdin();
    this.suspended = true;
    this.active = false;
    this.restoreOutput();
    this.origStdoutWrite("\x1b[?1049l");
  }

  /** Resume interception after an external prompt finishes. */
  unsuspend(): void {
    if (!this.suspended) return;
    this.suspended = false;

    this.hijackOutput();
    this.active = true;

    this.origStdoutWrite("\x1b[?1049h");
    this.origStdoutWrite("\x1b[2J\x1b[H");

    this.inputMode = this.savedMode || "output";
    this.startStdin();

    this.scheduleRender();
  }

  // ═══════════════════════════════════════════════════════════
  //  Output hijacking
  // ═══════════════════════════════════════════════════════════

  private hijackOutput(): void {
    this.origStdoutWrite = process.stdout.write.bind(process.stdout);
    this.origStderrWrite = process.stderr.write.bind(process.stderr);

    const self = this;
    process.stdout.write = function (
      chunk: any,
      encoding?: any,
      callback?: any
    ): boolean {
      if (!self.active) return self.origStdoutWrite(chunk, encoding, callback);
      self.ingest(String(chunk));
      return true;
    };

    process.stderr.write = function (
      chunk: any,
      encoding?: any,
      callback?: any
    ): boolean {
      if (!self.active) return self.origStderrWrite(chunk, encoding, callback);
      self.ingest(String(chunk));
      return true;
    };
  }

  private restoreOutput(): void {
    if (this.origStdoutWrite) process.stdout.write = this.origStdoutWrite;
    if (this.origStderrWrite) process.stderr.write = this.origStderrWrite;
  }

  /** Append raw text to the chat history buffer. */
  private ingest(text: string): void {
    if (!text) return;

    const combined = this.pendingLine + text;
    const lines = combined.split("\n");

    this.pendingLine = lines.pop() ?? "";

    for (const line of lines) {
      this.buffer.push(line);
    }

    if (this.buffer.length > 5000) {
      this.buffer = this.buffer.slice(-5000);
    }

    // new output snaps scroll to bottom
    this.scrollOffset = 0;
    this.scheduleRender();
  }

  private addOutput(text: string): void {
    this.ingest(text);
  }

  // ═══════════════════════════════════════════════════════════
  //  Rendering
  // ═══════════════════════════════════════════════════════════

  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 1000 / this.RENDER_FPS);
  }

  private render(force = false): void {
    if (!this.active && !force) return;
    if (this.isRendering) return;
    this.isRendering = true;

    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;
    const reserved = 2;               // separator + input line
    const outputHeight = Math.max(1, rows - reserved);

    const all = [...this.buffer];
    if (this.pendingLine) all.push(this.pendingLine);

    // respect scroll offset
    const visibleCount = Math.min(outputHeight, all.length);
    let start = Math.max(0, all.length - visibleCount - this.scrollOffset);
    if (start > all.length - visibleCount) {
      start = Math.max(0, all.length - visibleCount);
    }
    const visible = all.slice(start, start + outputHeight);

    let frame = "\x1b[2J\x1b[H";

    // ── history area ─────────────────────────────────────────
    for (let i = 0; i < outputHeight; i++) {
      frame += "\x1b[0m\x1b[2K";
      if (i < visible.length) {
        const line = visible[i];
        const stripped = stripAnsi(line);
        if (stripped.length > cols) {
          frame += truncateVisible(line, cols);
        } else {
          frame += line;
        }
      }
      frame += "\n";
    }

    // ── separator ───────────────────────────────────────────
    const sepRight = `🐝  ${this.model}`;
    const sepLeftLen = Math.max(0, cols - sepRight.length - 1);
    frame += "\x1b[0m\x1b[2K";
    frame += chalk.gray("─".repeat(sepLeftLen) + " " + sepRight);
    frame += "\n";

    // ── input box ───────────────────────────────────────────
    frame += "\x1b[0m\x1b[2K";
    const prompt = chalk.green(chalk.bold("> "));
    const inputLines = this.inputBuffer.split("\n");
    const firstLine = inputLines[0];
    const more = inputLines.length > 1 ? chalk.gray(` [+${inputLines.length - 1} lines]`) : "";
    const promptLen = 2;
    const moreLen = stripAnsi(String(more)).length;
    const maxInput = cols - promptLen - moreLen;
    const display = firstLine.slice(0, maxInput);
    frame += prompt + display + more;

    this.origStdoutWrite(frame);

    const cursorRow = rows;
    const cursorCol = promptLen + 1 + display.length;
    this.origStdoutWrite(`\x1b[${cursorRow};${cursorCol}H`);

    this.isRendering = false;
  }

  // ═══════════════════════════════════════════════════════════
  //  Scroll support
  // ═══════════════════════════════════════════════════════════

  private scrollUp(lines: number): void {
    const max = Math.max(0, this.buffer.length - ((process.stdout.rows || 24) - 2));
    this.scrollOffset = Math.min(max, this.scrollOffset + lines);
    this.scheduleRender();
  }

  private scrollDown(lines: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - lines);
    this.scheduleRender();
  }

  private scrollToTop(): void {
    const page = (process.stdout.rows || 24) - 2;
    this.scrollOffset = Math.max(0, this.buffer.length - page);
    this.scheduleRender();
  }

  private scrollToBottom(): void {
    this.scrollOffset = 0;
    this.scheduleRender();
  }

  // ═══════════════════════════════════════════════════════════
  //  Escape-sequence handling
  // ═══════════════════════════════════════════════════════════

  private handleEscapeSequence(seq: string): boolean {
    // Arrow / scroll keys
    if (seq === "\x1b[A" || seq === "\x1bOA") {
      this.scrollUp(3);
      return true;
    }
    if (seq === "\x1b[B" || seq === "\x1bOB") {
      this.scrollDown(3);
      return true;
    }
    // Page Up / Page Down
    if (seq === "\x1b[5~") {
      this.scrollUp(Math.floor((process.stdout.rows || 24) / 2));
      return true;
    }
    if (seq === "\x1b[6~") {
      this.scrollDown(Math.floor((process.stdout.rows || 24) / 2));
      return true;
    }
    // Home / End
    if (seq === "\x1b[H" || seq === "\x1b[1~") {
      this.scrollToTop();
      return true;
    }
    if (seq === "\x1b[F" || seq === "\x1b[4~") {
      this.scrollToBottom();
      return true;
    }
    // discard everything else (mouse, fn keys, etc.)
    return false;
  }

  // ═══════════════════════════════════════════════════════════
  //  Raw input handling
  // ═══════════════════════════════════════════════════════════

  private readInput(): Promise<string | null> {
    return new Promise((resolve) => {
      this.inputResolve = resolve;
      this.inputMode = "input";
      this.inputBuffer = "";
      this.scrollToBottom();
      this.scheduleRender();
    });
  }

  private doSubmit(): void {
    const result = this.inputBuffer.trim();
    this.inputBuffer = "";
    this.pasteMode = false;
    this.inputMode = "output";
    if (this.inputResolve) {
      this.inputResolve(result);
      this.inputResolve = null;
    }
  }

  private doCancel(): void {
    this.inputBuffer = "";
    this.pasteMode = false;
    this.inputMode = "output";
    if (this.inputResolve) {
      this.inputResolve(null);
      this.inputResolve = null;
    }
  }

  private startStdin(): void {
    const stdin = process.stdin;
    if ("setRawMode" in stdin && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", this.onStdinData);
    this.origStdoutWrite("\x1b[?2004h");
  }

  private stopStdin(): void {
    const stdin = process.stdin;
    if ("setRawMode" in stdin && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(false);
    }
    stdin.pause();
    stdin.removeAllListeners("data");
    this.origStdoutWrite("\x1b[?2004l");
  }

  private readonly onStdinData = (data: string): void => {
    if (this.inputMode === "external") return;
    this.processStdinData(data);
  };

  private processStdinData(data: string): void {
    let pending = data;
    const ESC_SEQ_RE = /^\x1b(?:\[[0-9;]*[A-Za-z~]|\[[<>][0-9;]*[Mm]|O[A-Za-z])/;

    while (pending.length > 0) {
      // ── Bracketed paste markers ──────────────────────────
      if (pending.startsWith("\x1b[200~")) {
        this.pasteMode = true;
        pending = pending.slice(6);
        continue;
      }
      if (pending.startsWith("\x1b[201~")) {
        this.pasteMode = false;
        pending = pending.slice(6);
        continue;
      }

      // ── Escape sequences ─────────────────────────────────
      const escMatch = pending.match(ESC_SEQ_RE);
      if (escMatch) {
        this.handleEscapeSequence(escMatch[0]);
        pending = pending.slice(escMatch[0].length);
        continue;
      }
      if (pending.startsWith("\x1b")) {
        // Unknown or incomplete sequence — discard \x1b and continue
        pending = pending.slice(1);
        continue;
      }

      const ch = pending[0];
      const code = ch.charCodeAt(0);

      // ── Enter (CR) ───────────────────────────────────────
      if (ch === "\r") {
        const hasLF = pending.length > 1 && pending[1] === "\n";
        if (this.pasteMode) {
          this.inputBuffer += "\n";
          pending = pending.slice(hasLF ? 2 : 1);
          this.scrollToBottom();
          continue;
        }
        if (this.inputMode === "input") {
          pending = pending.slice(hasLF ? 2 : 1);
          this.doSubmit();
          return;
        }
        pending = pending.slice(hasLF ? 2 : 1);
        continue;
      }

      // Newline (LF)
      if (ch === "\n") {
        if (this.pasteMode) {
          this.inputBuffer += "\n";
          pending = pending.slice(1);
          this.scrollToBottom();
          continue;
        }
        if (this.inputMode === "input") {
          this.inputBuffer += "\n";
          pending = pending.slice(1);
          this.scrollToBottom();
          continue;
        }
        pending = pending.slice(1);
        continue;
      }

      // Backspace / Delete
      if (code === 127 || code === 8) {
        if (this.inputMode === "input" && this.inputBuffer.length > 0) {
          this.inputBuffer = this.inputBuffer.slice(0, -1);
          if (this.inputBuffer.length === 0) this.pasteMode = false;
        }
        pending = pending.slice(1);
        this.scrollToBottom();
        continue;
      }

      // Tab
      if (code === 9) {
        if (this.inputMode === "input") {
          this.inputBuffer += "\t";
        }
        pending = pending.slice(1);
        this.scrollToBottom();
        continue;
      }

      // Control characters
      if (code < 32) {
        if (code === 3) {
          this.stopStdin();
          process.exit(0);
        }
        if (code === 4 && this.inputMode === "input") {
          this.doCancel();
          return;
        }
        pending = pending.slice(1);
        continue;
      }

      // Normal printable character
      if (this.inputMode === "input") {
        this.inputBuffer += ch;
        this.scrollToBottom();
      }
      pending = pending.slice(1);
    }

    this.scheduleRender();
  }

  // ═══════════════════════════════════════════════════════════
  //  Helpers
  // ═══════════════════════════════════════════════════════════

  private printBanner(): void {
    this.addOutput(BANNER + "\n");
  }

  private printModelInfo(): void {
    this.addOutput(chalk.gray(`  Model: ${this.model}  │  Provider: ${this.provider}`) + "\n");
  }
}

// ── ANSI helpers ─────────────────────────────────────────────

const ANSI_RE =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

/** Truncate a string so its *visible* width ≤ max, preserving ANSI codes. */
function truncateVisible(str: string, max: number): string {
  let visible = 0;
  let result = "";
  let inAnsi = false;
  for (const ch of str) {
    if (ch === "\u001b" || ch === "\u009b") {
      inAnsi = true;
      result += ch;
      continue;
    }
    if (inAnsi) {
      result += ch;
      if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "\u0007") {
        inAnsi = false;
      }
      continue;
    }
    if (visible >= max) break;
    result += ch;
    visible++;
  }
  return result;
}
