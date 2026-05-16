#!/usr/bin/env node

// Skip in CI environments
if (process.env.CI) {
  process.exit(0);
}

const C = {
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

console.log(`
${C.cyan}╔══════════════════════════════════════════════════════════════════╗${C.reset}
${C.cyan}║${C.reset}  ${C.bold}🐝  Swarm CLI installed!${C.reset}                                         ${C.cyan}║${C.reset}
${C.cyan}╠══════════════════════════════════════════════════════════════════╣${C.reset}
${C.cyan}║${C.reset}  You're on a ${C.yellow}BETA${C.reset} release — every bit of feedback shapes the      ${C.cyan}║${C.reset}
${C.cyan}║${C.reset}  road ahead. Found a bug? Have an idea? Want a feature?        ${C.cyan}║${C.reset}
${C.cyan}║${C.reset}                                                                  ${C.cyan}║${C.reset}
${C.cyan}║${C.reset}  ${C.bold}📝  Open an issue:${C.reset}                                              ${C.cyan}║${C.reset}
${C.cyan}║${C.reset}     ${C.green}https://github.com/harry-bob/harrybob-swarm/issues${C.reset}            ${C.cyan}║${C.reset}
${C.cyan}║${C.reset}                                                                  ${C.cyan}║${C.reset}
${C.cyan}║${C.reset}  ${C.bold}⭐  Star the repo${C.reset} if you find it useful — it keeps us going!      ${C.cyan}║${C.reset}
${C.cyan}║${C.reset}                                                                  ${C.cyan}║${C.reset}
${C.cyan}║${C.reset}  ${C.gray}Tip: run 'swarm' to start, or 'swarm init' in a new directory.${C.reset}  ${C.cyan}║${C.reset}
${C.cyan}╚══════════════════════════════════════════════════════════════════╝${C.reset}
`);
