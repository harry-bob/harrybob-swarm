import { exec, ChildProcess } from "node:child_process";
import { Tool } from "./types.js";
import { Sandbox } from "./sandbox.js";

const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds

export function createRunCommandTool(sandbox: Sandbox, timeoutMs = DEFAULT_TIMEOUT_MS): Tool {
  return {
    definition: {
      name: "run_command",
      description: "Execute a shell command and return its stdout/stderr. Has a 30-second timeout. Use for running code, installing packages, etc.",
      parameters: {
        command: { type: "string", description: "The shell command to execute" },
      },
    },
    async execute(args) {
      const command = args.command as string;
      const cwd = sandbox.getRoot();

      return new Promise((resolve) => {
        const child: ChildProcess = exec(command, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
          let output = "";
          if (stdout) output += stdout;
          if (stderr) output += `\nSTDERR:\n${stderr}`;
          if (error) {
            if ((error as any).killed) {
              output += `\nTIMEOUT: Command exceeded ${timeoutMs / 1000}s and was killed.`;
            } else {
              output += `\nERROR: ${error.message}`;
            }
          }
          resolve(output.trim() || "(no output)");
        });

        // Kill process after timeout
        if (timeoutMs > 0) {
          setTimeout(() => {
            child.kill("SIGTERM");
            // Force kill after 2s if still alive
            setTimeout(() => {
              try { child.kill("SIGKILL"); } catch {}
            }, 2000);
          }, timeoutMs);
        }
      });
    },
  };
}
