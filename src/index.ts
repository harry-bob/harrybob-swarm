#!/usr/bin/env node

import { config } from "dotenv";
import { join } from "node:path";
import { cwd } from "node:process";

// Load .env from the current working directory (user's project)
const envPath = join(cwd(), ".env");
const envResult = config({ path: envPath });
if (envResult.error) {
  console.error(`[swarm] dotenv failed to load ${envPath}: ${envResult.error.message}`);
} else if (!envResult.parsed?.TAVILY_API_KEY) {
  console.error(`[swarm] Warning: TAVILY_API_KEY not found in ${envPath}`);
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
