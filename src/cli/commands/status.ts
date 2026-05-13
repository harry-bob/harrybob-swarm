import { Command } from "commander";
import { loadConfig } from "../../config/config.js";
import { logInfo, logWarning } from "../../utils/logger.js";

export function statusCommand(program: Command): void {
  program
    .command("status")
    .description("Show current swarm status and configuration")
    .action(async () => {
      const config = await loadConfig();

      if (!config) {
        logWarning("No swarm configuration found. Run `swarm init` to get started.");
        return;
      }

      console.log("\n🐝 Swarm Status");
      console.log("─".repeat(40));
      console.log(`Version:      ${config.version}`);
      console.log(`Provider:     ${config.provider}`);
      console.log(`Model:        ${config.model}`);
      console.log(`Agents:       ${Object.keys(config.agents).length}`);
      for (const [name, agent] of Object.entries(config.agents)) {
        console.log(`  - ${name} (${agent.role})`);
      }
      console.log(`Max Concurrent: ${config.orchestration.maxConcurrentAgents}`);
      console.log(`Timeout:        ${config.orchestration.timeout}ms`);
      console.log("─".repeat(40));

      process.exit(0);
    });
}
