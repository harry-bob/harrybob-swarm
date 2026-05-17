import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Tool } from "./types.js";
import { Sandbox } from "./sandbox.js";

/**
 * Simple per-subtask cache for read_file results.
 * Invalidated when files are written/edited.
 */
export class FileCache {
  private cache = new Map<string, string>();

  get(path: string): string | undefined {
    return this.cache.get(path);
  }

  set(path: string, content: string): void {
    this.cache.set(path, content);
  }

  invalidate(path: string): void {
    this.cache.delete(path);
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}

export function createReadFileTool(sandbox: Sandbox, cache?: FileCache): Tool {
  return {
    definition: {
      name: "read_file",
      description: "Read the contents of a file at the given path. Returns the file contents as text.",
      parameters: {
        path: { type: "string", description: "Relative or absolute file path to read" },
      },
    },
    async execute(args) {
      const filePath = sandbox.validate(args.path as string);
      const relPath = sandbox.relative(args.path as string);

      // Check cache first
      if (cache) {
        const cached = cache.get(relPath);
        if (cached !== undefined) {
          return cached;
        }
      }

      try {
        let lastErr = "";
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const content = await readFile(filePath, "utf-8");
            if (cache) cache.set(relPath, content);
            return content;
          } catch (err: unknown) {
            lastErr = err instanceof Error ? err.message : String(err);
            const isTransient = lastErr.includes("ENOENT") || lastErr.includes("EAGAIN") || lastErr.includes("EBUSY");
            if (isTransient && attempt < 3) {
              await new Promise((r) => setTimeout(r, 150 * attempt));
              continue;
            }
            break;
          }
        }
        return `Error reading file: ${lastErr}`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error reading file: ${message}`;
      }
    },
  };
}

export function createWriteFileTool(sandbox: Sandbox, cache?: FileCache): Tool {
  return {
    definition: {
      name: "write_file",
      description: "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
      parameters: {
        path: { type: "string", description: "Relative or absolute file path to write" },
        content: { type: "string", description: "The content to write to the file" },
      },
    },
    async execute(args) {
      const filePath = sandbox.validate(args.path as string);
      try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, args.content as string, "utf-8");
        // Invalidate cache for this file
        if (cache) {
          cache.invalidate(sandbox.relative(args.path as string));
        }
        return `File written: ${sandbox.relative(args.path as string)}`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error writing file: ${message}`;
      }
    },
  };
}

export function createEditFileTool(sandbox: Sandbox, cache?: FileCache): Tool {
  return {
    definition: {
      name: "edit_file",
      description: "Edit a file by replacing exact text. The oldText must match a unique section of the file exactly.",
      parameters: {
        path: { type: "string", description: "Relative or absolute file path to edit" },
        oldText: { type: "string", description: "The exact text to find and replace (must match exactly)" },
        newText: { type: "string", description: "The replacement text" },
      },
    },
    async execute(args) {
      const filePath = sandbox.validate(args.path as string);
      const oldText = args.oldText as string;
      const newText = args.newText as string;
      try {
        let content = await readFile(filePath, "utf-8");
        if (!content.includes(oldText)) {
          return `Error: oldText not found in file. Make sure it matches exactly (including whitespace and indentation).`;
        }
        content = content.replace(oldText, newText);
        await writeFile(filePath, content, "utf-8");
        // Invalidate cache for this file
        if (cache) {
          cache.invalidate(sandbox.relative(args.path as string));
        }
        return `File edited: ${sandbox.relative(args.path as string)}`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error editing file: ${message}`;
      }
    },
  };
}

export function createListFilesTool(sandbox: Sandbox): Tool {
  return {
    definition: {
      name: "list_files",
      description: "List files and directories at the given path. Defaults to current directory.",
      parameters: {
        path: { type: "string", description: "Directory path to list (default: current directory)", required: false },
      },
    },
    async execute(args) {
      const dirPath = sandbox.validate((args.path as string) || ".");
      try {
        const entries = await readdir(dirPath, { withFileTypes: true });
        const filtered = entries.filter((e) => {
          const name = e.name;
          return !name.startsWith(".") || name === ".swarmrc.json";
        });
        const lines = filtered.map((e) => {
          const isDir = e.isDirectory();
          return `${isDir ? "[DIR]" : "[FILE]"} ${e.name}`;
        });
        return lines.join("\n") || "(empty directory)";
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error listing files: ${message}`;
      }
    },
  };
}
