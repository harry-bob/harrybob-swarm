import chalk from "chalk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SWARM_DIR = join(homedir(), ".swarm");
const BANNER_STATE = join(SWARM_DIR, "beta-banner.json");
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // once per day

interface BannerState {
  lastShown: number;
}

function shouldShow(): boolean {
  if (process.env.SWARM_NO_BETA_BANNER === "1") return false;

  try {
    if (!existsSync(BANNER_STATE)) return true;
    const state = JSON.parse(readFileSync(BANNER_STATE, "utf-8")) as BannerState;
    return Date.now() - state.lastShown > COOLDOWN_MS;
  } catch {
    return true;
  }
}

function recordShown(): void {
  try {
    mkdirSync(SWARM_DIR, { recursive: true });
    writeFileSync(BANNER_STATE, JSON.stringify({ lastShown: Date.now() }));
  } catch {
    // best-effort
  }
}

export function showBetaBanner(): void {
  if (!shouldShow()) return;

  console.log();
  console.log(chalk.yellow("╔══════════════════════════════════════════════════════════════╗"));
  console.log(chalk.yellow("║  🐝  BETA RELEASE                                            ║"));
  console.log(chalk.yellow("║                                                              ║"));
  console.log(chalk.yellow("║  Thanks for trying Swarm beta!                               ║"));
  console.log(chalk.yellow('║  Send feedback: swarm feedback "your thoughts here"          ║'));
  console.log(chalk.yellow("║  Set SWARM_NO_BETA_BANNER=1 to hide this banner            ║"));
  console.log(chalk.yellow("╚══════════════════════════════════════════════════════════════╝"));
  console.log();

  recordShown();
}
