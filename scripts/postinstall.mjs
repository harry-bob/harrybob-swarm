#!/usr/bin/env node

// Skip in CI environments
if (process.env.CI) {
  process.exit(0);
}

console.log(`
🐝  Swarm CLI (BETA) installed successfully!

You're running a beta release — your feedback directly shapes the product.

📝  Share feedback, bugs, or ideas:
    https://github.com/harry-bob/harrybob-swarm/issues

Every comment helps. Thank you!
`);
