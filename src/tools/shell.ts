import { exec } from "node:child_process";
import { Tool } from "./types.js";
import { Sandbox } from "./sandbox.js";

export function createRunCommandTool(sandbox: Sandbox): Tool {
  return {
    definition: {
      name: "run_command",
      description: "Execute a shell command and return its stdout/stderr. Use for running code, installing packages, etc.",
      parameters: {
        command: { type: "string", description: "The shell command to execute" },
      },
    },
    async execute(args) {
      const command = args.command as string;
      const cwd = sandbox.getRoot();

      return new Promise((resolve) => {
        exec(command, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
          let output = "";
          if (stdout) output += stdout;
          if (stderr) output += `\nSTDERR:\n${stderr}`;
          if (error) output += `\nERROR: ${error.message}`;
          resolve(output.trim() || "(no output)");
        });
      });
    },
  };
}
