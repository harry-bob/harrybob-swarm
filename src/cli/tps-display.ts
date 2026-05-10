import chalk from "chalk";

/**
 * Manages a live TPS (tokens per second) display in the bottom-right corner.
 * Uses ANSI escape codes to position the cursor without interfering with output.
 */
export class TPSDisplay {
  private tokenCount = 0;
  private startTime = 0;
  private lastUpdateTime = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private label = "";

  start(label: string) {
    this.label = label;
    this.tokenCount = 0;
    this.startTime = Date.now();
    this.lastUpdateTime = Date.now();

    // Update display every 500ms
    this.interval = setInterval(() => this.render(), 500);
  }

  addTokens(count: number = 1) {
    this.tokenCount += count;
  }

  stop(): { tokens: number; durationMs: number; tps: number } {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    // Clear the TPS line
    this.clear();

    const durationMs = Date.now() - this.startTime;
    const tps = durationMs > 0 ? (this.tokenCount / (durationMs / 1000)) : 0;

    return { tokens: this.tokenCount, durationMs, tps };
  }

  private render() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    if (elapsed < 0.1) return;

    const tps = this.tokenCount / elapsed;
    const tpsStr = `${tps.toFixed(1)} tok/s`;
    const countStr = `${this.tokenCount} tokens`;

    // Write to stderr at the current position
    process.stderr.write(
      chalk.gray(`\r  ${this.label ? this.label + " " : ""}${countStr} · ${tpsStr}   `)
    );
  }

  private clear() {
    process.stderr.write("\r\x1b[K");
  }
}
