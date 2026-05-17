import chalk from "chalk";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

/**
 * Listens for slash commands typed by the user during a swarm run.
 *
 * /status — print current subtask progress and elapsed time
 * /skip   — mark the current subtask as skipped at the next checkpoint
 * /stop   — stop the run after the current subtask completes
 *
 * Pauses automatically when ask_user_question is active so the answer
 * is never misinterpreted as a slash command.
 */
export class RunController {
  skipRequested = false;
  stopRequested = false;

  // Populated by the orchestrator as work progresses
  currentSubtaskId = "";
  currentSubtaskTitle = "";
  subtaskIndex = 0;
  totalSubtasks = 0;
  completedCount = 0;
  readonly startTime = Date.now();

  private lineBuffer = "";
  private paused = false;
  private onData: ((chunk: string) => void) | null = null;
  private readonly onPause = () => { this.paused = true; };
  private readonly onResume = () => { this.paused = false; };

  /** Start listening. No-op if stdin is not a TTY (piped/scripted input). */
  start(): void {
    if (!process.stdin.isTTY) return;

    this.onData = (chunk: string) => {
      if (this.paused) return;
      this.lineBuffer += chunk;
      const lines = this.lineBuffer.split("\n");
      this.lineBuffer = lines.pop()!;
      for (const line of lines) {
        this.handleLine(line.trim());
      }
    };

    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", this.onData);
    process.on("swarm::interactivePromptStart", this.onPause);
    process.on("swarm::interactivePromptEnd", this.onResume);

    console.log(chalk.gray("  💡 Type /status, /skip, or /stop at any time\n"));
  }

  /** Remove all listeners. Call this when the run finishes. */
  stop(): void {
    if (this.onData) {
      process.stdin.removeListener("data", this.onData);
      this.onData = null;
    }
    process.removeListener("swarm::interactivePromptStart", this.onPause);
    process.removeListener("swarm::interactivePromptEnd", this.onResume);
  }

  /** Update which subtask is currently running. */
  update(subtaskId: string, subtaskTitle: string, index: number, total: number): void {
    this.currentSubtaskId = subtaskId;
    this.currentSubtaskTitle = subtaskTitle;
    this.subtaskIndex = index;
    this.totalSubtasks = total;
  }

  /** Returns true and resets the flag if a skip was requested. */
  consumeSkip(): boolean {
    const v = this.skipRequested;
    this.skipRequested = false;
    return v;
  }

  private handleLine(line: string): void {
    if (!line.startsWith("/")) return;

    switch (line.toLowerCase()) {
      case "/status":
        this.printStatus();
        break;

      case "/skip":
        this.skipRequested = true;
        console.log(chalk.yellow("\n⚡ /skip — current subtask will be skipped at next checkpoint\n"));
        break;

      case "/stop":
        this.stopRequested = true;
        console.log(chalk.yellow("\n⚡ /stop — run will stop after current subtask completes\n"));
        break;

      default:
        console.log(chalk.gray(`\nUnknown command: ${line}  (available: /status  /skip  /stop)\n`));
    }
  }

  private printStatus(): void {
    const elapsed = formatDuration(Date.now() - this.startTime);
    const progress = `${this.completedCount}/${this.totalSubtasks} subtasks`;
    const current = this.currentSubtaskId
      ? `[${this.currentSubtaskId}] ${this.currentSubtaskTitle}`
      : "(idle)";
    const flags = [
      this.stopRequested ? chalk.yellow("stop pending") : "",
      this.skipRequested ? chalk.yellow("skip pending") : "",
    ].filter(Boolean).join(", ");

    console.log(chalk.cyan("\n  ── /status ──────────────────────────────────"));
    console.log(chalk.cyan(`  Current:  ${current}`));
    console.log(chalk.cyan(`  Progress: ${progress} done`));
    console.log(chalk.cyan(`  Elapsed:  ${elapsed}`));
    if (flags) console.log(chalk.cyan(`  Pending:  ${flags}`));
    console.log(chalk.cyan("  ─────────────────────────────────────────────\n"));
  }
}
