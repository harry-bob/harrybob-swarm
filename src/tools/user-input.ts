import * as readline from "node:readline";
import { Tool } from "./types.js";
import chalk from "chalk";

function askUser(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr, // write prompt to stderr so stdout stays clean for piping
    });

    console.error(chalk.green(`\n💬 Architect asks: ${promptText}`));
    console.error(chalk.gray("Your answer: "));

    rl.question("", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function createAskUserQuestionTool(): Tool {
  return {
    definition: {
      name: "ask_user_question",
      description:
        "Ask the user a clarifying question before creating the plan. Use this when the task is ambiguous, missing details, or has multiple possible interpretations. The user's answer will be returned to you.",
      parameters: {
        question: {
          type: "string",
          description: "The question to ask the user",
        },
      },
    },
    async execute(args) {
      const question = args.question as string;
      if (!question) return "Error: No question provided";

      // Signal TUI (if active) to suspend so the prompt appears clearly
      process.emit("swarm::interactivePromptStart", undefined);

      const answer = await askUser(question);

      process.emit("swarm::interactivePromptEnd", undefined);

      if (!answer) {
        return "(User provided no answer. Proceed with reasonable defaults.)";
      }
      return `User answered: "${answer}"`;
    },
  };
}
