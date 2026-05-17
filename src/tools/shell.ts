import { spawn, type ChildProcess } from "node:child_process";
import { Tool } from "./types.js";
import { Sandbox } from "./sandbox.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 90_000;
const MAX_BUFFER = 10 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;
const HARD_RESOLVE_MS = 5_000;

function killTree(child: ChildProcess, isUnix: boolean): void {
  if (isUnix && child.pid) {
    // Kill the entire process group so shell-spawned children die too
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, KILL_GRACE_MS);
  } else {
    child.kill("SIGTERM");
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, KILL_GRACE_MS);
  }
}

export function runCommand(command: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let resolved = false;
    let killed = false;
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;

    function finish(output: string) {
      if (resolved) return;
      resolved = true;
      resolve(output.trim() || "(no output)");
    }

    const isUnix = process.platform !== "win32";

    // detached=true on Unix creates a new process group → we can kill the whole tree
    const child = spawn(command, {
      shell: true,
      cwd,
      detached: isUnix,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (data: string) => {
      stdout += data;
      totalBytes += Buffer.byteLength(data, "utf8");
      if (totalBytes > MAX_BUFFER) {
        killed = true;
        killTree(child, isUnix);
        finish(`ERROR: Max buffer exceeded (${MAX_BUFFER / 1024 / 1024}MB)\n${stdout.slice(0, 5000)}`);
      }
    });

    child.stderr?.on("data", (data: string) => {
      stderr += data;
      totalBytes += Buffer.byteLength(data, "utf8");
      if (totalBytes > MAX_BUFFER) {
        killed = true;
        killTree(child, isUnix);
        finish(`ERROR: Max buffer exceeded (${MAX_BUFFER / 1024 / 1024}MB)\n${stdout.slice(0, 5000)}`);
      }
    });

    child.on("error", (err) => {
      finish(`ERROR: ${err.message}\n${stdout}\n${stderr}`);
    });

    child.on("close", (code, signal) => {
      let output = stdout;
      if (stderr) output += `\nSTDERR:\n${stderr}`;
      if (killed) output += `\nTIMEOUT: Command exceeded ${timeoutMs / 1000}s and was killed.`;
      else if (code !== null && code !== 0) output += `\nEXIT CODE: ${code}`;
      finish(output);
    });

    if (timeoutMs > 0) {
      setTimeout(() => {
        if (resolved) return;
        killed = true;
        killTree(child, isUnix);

        // Hard timeout: force resolve even if orphan processes keep streams open
        setTimeout(() => {
          if (!resolved) {
            finish(
              `TIMEOUT: Command exceeded ${timeoutMs / 1000}s and was killed.\n${stdout}\n${stderr}`
            );
          }
        }, HARD_RESOLVE_MS);
      }, timeoutMs);
    }
  });
}

export function createRunCommandTool(sandbox: Sandbox, defaultTimeoutMs = DEFAULT_TIMEOUT_MS): Tool {
  return {
    definition: {
      name: "run_command",
      description:
        `Execute a shell command and return its stdout/stderr. Default timeout is 30s — commands killed if they exceed it. Pass timeout=N (seconds) to override (maximum ${MAX_TIMEOUT_MS / 1000}s).`,
      parameters: {
        command: { type: "string", description: "The shell command to execute" },
        timeout: {
          type: "number",
          description: `Timeout in seconds (default: 30, max: ${MAX_TIMEOUT_MS / 1000}).`,
          required: false,
        },
      },
    },
    async execute(args) {
      const command = args.command as string;
      const cwd = sandbox.getRoot();
      const requestedTimeoutSec =
        typeof args.timeout === "number" && !isNaN(args.timeout) ? args.timeout : undefined;
      const requestedMs = requestedTimeoutSec != null ? requestedTimeoutSec * 1000 : defaultTimeoutMs;
      const timeoutMs = Math.min(requestedMs, MAX_TIMEOUT_MS);

      return runCommand(command, cwd, timeoutMs);
    },
  };
}
