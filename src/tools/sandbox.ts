import { resolve, relative, isAbsolute } from "node:path";

/**
 * Validates that a file path is within the allowed directory (sandbox).
 * Prevents path traversal attacks and access outside the project.
 */
export class Sandbox {
  private root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * Resolve and validate a path. Returns the resolved absolute path
   * if it's within the sandbox, or throws an error if it's outside.
   */
  validate(path: string): string {
    const resolved = resolve(this.root, path);

    // Check if the resolved path is within the sandbox root
    if (!resolved.startsWith(this.root + "/") && resolved !== this.root) {
      const rel = relative(this.root, resolved);
      throw new Error(
        `Access denied: "${path}" resolves to "${rel}" which is outside the project directory.\n` +
        `The swarm can only access files within: ${this.root}`
      );
    }

    return resolved;
  }

  /**
   * Get the sandbox root directory.
   */
  getRoot(): string {
    return this.root;
  }

  /**
   * Check if a path is within the sandbox without throwing.
   */
  isAllowed(path: string): boolean {
    try {
      this.validate(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get a relative path from the sandbox root (for display).
   */
  relative(path: string): string {
    const resolved = resolve(this.root, path);
    return relative(this.root, resolved) || ".";
  }
}
