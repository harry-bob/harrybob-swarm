#!/usr/bin/env node

// Skip in CI environments
if (process.env.CI) {
  process.exit(0);
}

console.log(`
🐝  Swarm CLI (BETA) installed successfully!

Thank you for trying the beta release.
Feedback & issues: https://github.com/harry-bob/harrybob-swarm/issues
`);
