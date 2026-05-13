#!/usr/bin/env node

import { config } from "dotenv";
import { join } from "node:path";
import { cwd } from "node:process";

// Load .env from the current working directory (user's project)
config({ path: join(cwd(), ".env") });

import { createCLI } from "./cli/index.js";

const cli = createCLI();
cli.parseAsync(process.argv)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
