import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
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
        "Write and automatically execute an independent test script. The code is saved to test/{taskId}/reviewer{index}/ and run. Returns the execution output including stdout, stderr, and exit code.",
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

      // Build path inside the project sandbox
      const relDir = `test/${taskId}/reviewer${reviewerIndex}`;
      const dirPath = sandbox.validate(relDir);
      const filePath = join(dirPath, filename);

      await mkdir(dirPath, { recursive: true });
      await writeFile(filePath, code, "utf-8");

      // Determine runner from extension
      const relFilePath = join(relDir, filename);
      let command: string;
      if (filename.endsWith(".py")) {
        command = `python "${relFilePath}"`;
      } else if (filename.endsWith(".ts")) {
        command = `npx tsx "${relFilePath}"`;
      } else if (filename.endsWith(".sh")) {
        command = `bash "${relFilePath}"`;
      } else {
        command = `node "${relFilePath}"`;
      }

      const output = await runCommand(command, sandbox.getRoot(), 60_000);

      return [
        `Test saved to: ${relFilePath}`,
        "",
        `Executed: ${command}`,
        "",
        output,
      ].join("\n");
    },
  };
}
