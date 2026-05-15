import { Command } from "commander";
import chalk from "chalk";
import { logSuccess, logInfo, logWarning, logError } from "../../utils/logger.js";
import { getPackageVersion } from "../../utils/version.js";
import { spawn } from "node:child_process";

const REPO_OWNER = "harry-bob";
const REPO_NAME = "harrybob-swarm";
const ISSUES_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues`;
const API_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues`;

export function feedbackCommand(program: Command): void {
  program
    .command("feedback [message...]")
    .description("Send feedback about the beta release as a GitHub issue")
    .option("--view", "Open the GitHub issues page to see all feedback")
    .action(async (messageParts: string[], options: { view?: boolean }) => {
      if (options.view) {
        openIssuesPage();
        return;
      }

      const message = messageParts.join(" ").trim();
      if (!message || message.length === 0) {
        console.log(chalk.red("Please provide a feedback message."));
        console.log(chalk.gray('Example: swarm feedback "Great tool, but needs better error messages"'));
        process.exit(1);
      }

      await submitFeedback(message);
    });
}

async function submitFeedback(message: string): Promise<void> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    logError("GitHub token not found.");
    console.log(chalk.gray("Set GITHUB_TOKEN in your environment to submit feedback via GitHub Issues."));
    console.log(chalk.gray("You can create one at: https://github.com/settings/tokens"));
    console.log();
    console.log(chalk.cyan("Alternatively, open an issue manually:"));
    console.log(chalk.white(ISSUES_URL));
    process.exit(1);
  }

  const title = `Beta feedback: ${message.slice(0, 60)}${message.length > 60 ? "..." : ""}`;
  const body = [
    `**Version:** v${getPackageVersion()}`,
    `**Date:** ${new Date().toISOString()}`,
    "",
    "---",
    "",
    message,
  ].join("\n");

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title,
        body,
        labels: ["feedback", "beta"],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GitHub API ${response.status}: ${errorBody}`);
    }

    const data = (await response.json()) as { html_url: string; number: number };
    logSuccess(`Feedback submitted as GitHub Issue #${data.number}`);
    logInfo(data.html_url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Failed to submit feedback: ${msg}`);
    console.log();
    console.log(chalk.cyan("You can still open an issue manually here:"));
    console.log(chalk.white(ISSUES_URL));
    process.exit(1);
  }
}

function openIssuesPage(): void {
  console.log(chalk.cyan("GitHub Issues page for Swarm:"));
  console.log(chalk.white(ISSUES_URL));
  console.log();

  // Attempt to open the browser using available OS commands
  const commands: string[][] = [
    ["open", ISSUES_URL],
    ["xdg-open", ISSUES_URL],
    ["start", ISSUES_URL],
  ];

  let spawned = false;
  for (const cmd of commands) {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true });
    child.on("error", () => {
      // Try next command
    });
    child.on("spawn", () => {
      spawned = true;
      child.unref();
    });
  }

  // Exit shortly after; if a browser opened it'll survive because it's detached
  setTimeout(() => process.exit(0), 300);
}
