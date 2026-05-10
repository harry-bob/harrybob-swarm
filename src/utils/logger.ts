import chalk from "chalk";

export function log(message: string): void {
  console.log(message);
}

export function logInfo(message: string): void {
  console.log(chalk.blue("ℹ"), message);
}

export function logSuccess(message: string): void {
  console.log(chalk.green("✓"), message);
}

export function logWarning(message: string): void {
  console.log(chalk.yellow("⚠"), message);
}

export function logError(message: string): void {
  console.error(chalk.red("✗"), message);
}

export function logDebug(message: string): void {
  if (process.env.DEBUG) {
    console.log(chalk.gray("🔍"), message);
  }
}
