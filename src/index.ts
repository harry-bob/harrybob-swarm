#!/usr/bin/env node

import { config } from "dotenv";
import { join, dirname } from "node:path";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

// Find swarm package root (directory containing package.json)
function findSwarmRoot(): string {
  const startDir = dirname(fileURLToPath(import.meta.url));
  let dir = startDir;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return startDir;
}

const swarmRoot = findSwarmRoot();

// Load fallback .env from swarm directory first
const fallbackResult = config({ path: join(swarmRoot, ".env") });

// Then load project-specific .env from cwd (overrides fallback)
const envPath = join(cwd(), ".env");
const envResult = config({ path: envPath });

if (envResult.error) {
  if (fallbackResult.parsed?.TAVILY_API_KEY) {
    console.error(`[swarm] Loaded .env from ${join(swarmRoot, ".env")} (no .env found in ${cwd()})`);
  } else {
    console.error(`[swarm] dotenv failed to load ${envPath}: ${envResult.error.message}`);
  }
} else if (!process.env.TAVILY_API_KEY) {
  console.error(`[swarm] Warning: TAVILY_API_KEY not found. Set it in ${envPath} or ${join(swarmRoot, ".env")}`);
} else {
  console.error(`[swarm] Loaded .env from ${envPath}`);
}

import { createCLI } from "./cli/index.js";
import { showBetaBanner } from "./utils/beta-banner.js";

showBetaBanner();

const cli = createCLI();
cli.parseAsync(process.argv)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
