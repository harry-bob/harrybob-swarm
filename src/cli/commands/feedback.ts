import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { logSuccess, logInfo } from "../../utils/logger.js";
import { getPackageVersion } from "../../utils/version.js";

const SWARM_DIR = join(homedir(), ".swarm");
const FEEDBACK_FILE = join(SWARM_DIR, "feedback.json");

interface FeedbackEntry {
  message: string;
  timestamp: string;
  version: string;
}

export function feedbackCommand(program: Command): void {
  program
    .command("feedback [message...]")
    .description("Send feedback about the beta release (quote your message)")
    .option("--view", "View all submitted feedback")
    .action(async (messageParts: string[], options: { view?: boolean }) => {
      if (options.view) {
        viewFeedback();
        return;
      }

      const message = messageParts.join(" ").trim();
      if (!message || message.length === 0) {
        console.log(chalk.red("Please provide a feedback message."));
        console.log(chalk.gray('Example: swarm feedback "Great tool, but needs better error messages"'));
        process.exit(1);
      }

      submitFeedback(message);
    });
}

function submitFeedback(message: string): void {
  try {
    mkdirSync(SWARM_DIR, { recursive: true });

    let entries: FeedbackEntry[] = [];
    if (existsSync(FEEDBACK_FILE)) {
      entries = JSON.parse(readFileSync(FEEDBACK_FILE, "utf-8"));
    }

    entries.push({
      message,
      timestamp: new Date().toISOString(),
      version: getPackageVersion(),
    });

    writeFileSync(FEEDBACK_FILE, JSON.stringify(entries, null, 2));
    logSuccess("Feedback saved! Thank you for helping improve Swarm.");
    logInfo(`Stored at: ${FEEDBACK_FILE}`);
  } catch (err) {
    console.error(chalk.red("Failed to save feedback:"), err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

function viewFeedback(): void {
  if (!existsSync(FEEDBACK_FILE)) {
    console.log(chalk.gray("No feedback submitted yet."));
    return;
  }

  try {
    const entries: FeedbackEntry[] = JSON.parse(readFileSync(FEEDBACK_FILE, "utf-8"));
    if (entries.length === 0) {
      console.log(chalk.gray("No feedback submitted yet."));
      return;
    }

    console.log(chalk.cyan(`Feedback submissions (${entries.length} total):`));
    for (const entry of entries) {
      console.log(chalk.gray(`  [${entry.timestamp}] v${entry.version}`));
      console.log(`    ${entry.message}`);
    }
  } catch (err) {
    console.error(chalk.red("Failed to read feedback:"), err instanceof Error ? err.message : err);
  }
}
