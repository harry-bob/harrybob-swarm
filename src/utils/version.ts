import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | undefined;

export function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(__dirname, "../package.json"),   // bundled (dist/index.js)
      join(__dirname, "../../package.json"), // dev (src/utils/version.ts)
    ];
    for (const pkgPath of candidates) {
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
        cachedVersion = pkg.version;
        return cachedVersion;
      }
    }
    return "0.1.0";
  } catch {
    return "0.1.0";
  }
}
