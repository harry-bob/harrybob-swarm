import { writeFile, unlink } from "node:fs/promises";
import { join, extname } from "node:path";
import { Tool } from "./types.js";
import { Sandbox } from "./sandbox.js";
import { runCommand } from "./shell.js";

export function createReviewerTestTool(
  sandbox: Sandbox,
  taskId: string,
  reviewerIndex: number
): Tool {
  return {
    definition: {
      name: "do_test",
      description:
        "Write and automatically execute an independent test script in the project home directory. The code is saved to a temporary file, run from the project root, and deleted immediately after execution. Returns the execution output including stdout, stderr, and exit code.",
      parameters: {
        code: {
          type: "string",
          description:
            'Complete test script code. Must be runnable (e.g. a Node.js script with assertions, a Python script with unittest/pytest, or a shell script). Include the testing framework and assertions directly in the code — do not assume external test runners.',
        },
        filename: {
          type: "string",
          description:
            'Filename with extension, e.g. "test.js", "test.py", "test.ts", "test.sh". Determines the runtime. Defaults to "test.js".',
          required: false,
        },
      },
    },
    async execute(args) {
      const code = args.code as string;
      const filename = (args.filename as string) || "test.js";
      const ext = extname(filename) || ".js";

      // Create a temp file directly in the project root so imports work naturally
      const tmpName = `.swarm-review-${taskId}-r${reviewerIndex}-${Date.now()}${ext}`;
      const filePath = join(sandbox.getRoot(), tmpName);

      await writeFile(filePath, code, "utf-8");

      // Determine runner from extension
      let command: string;
      if (filename.endsWith(".py")) {
        command = `python "${tmpName}"`;
      } else if (filename.endsWith(".ts")) {
        command = `npx tsx "${tmpName}"`;
      } else if (filename.endsWith(".sh")) {
        command = `bash "${tmpName}"`;
      } else {
        command = `node "${tmpName}"`;
      }

      let output: string;
      try {
        output = await runCommand(command, sandbox.getRoot(), 60_000);
      } catch (err) {
        output = `Error during test execution: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Delete immediately after running (best-effort)
      try {
        await unlink(filePath);
      } catch {
        // ignore cleanup errors
      }

      return [
        `Test executed from project root: ${tmpName}`,
        "",
        `Command: ${command}`,
        "",
        output,
        "",
        "(test file deleted after execution)",
      ].join("\n");
    },
  };
}
