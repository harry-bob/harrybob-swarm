import { Command } from "commander";
import { loadConfig, saveConfig } from "../../config/config.js";
import { OllamaProvider } from "../../providers/ollama.js";
import { log, logSuccess, logInfo, logWarning } from "../../utils/logger.js";

export function initCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize swarm configuration in current directory")
    .option("--provider <provider>", "LLM provider (ollama, openai)", "ollama")
    .option("--model <model>", "Model to use (auto-detected from Ollama if not set)")
    .option("--base-url <url>", "Ollama API base URL", "http://localhost:11434")
    .action(async (options) => {
      logInfo("Initializing swarm configuration...");

      const existingConfig = await loadConfig();
      if (existingConfig) {
        log("Configuration already exists. Use --force to overwrite.");
        return;
      }

      // Auto-detect model from Ollama if not specified
      let model = options.model;
      if (!model && options.provider === "ollama") {
        try {
          const provider = new OllamaProvider({ baseURL: options.baseUrl });
          const models = await provider.listModels();
          if (models.length > 0) {
            model = models[0];
            logInfo(`Auto-detected model: ${model}`);
          } else {
            logWarning("No Ollama models found. Pull one with: ollama pull <model>");
            model = "llama3.1";
          }
        } catch {
          logWarning("Could not connect to Ollama, using default model");
          model = "llama3.1";
        }
      } else if (!model) {
        model = "gpt-4o";
      }

      const config = {
        version: "0.1.0",
        provider: options.provider,
        model,
        baseURL: options.baseUrl,
        agents: {
          researcher: {
            role: "researcher",
            systemPrompt: "You are a research agent. Your job is to gather information to help the architect plan effectively. Use web_search to find documentation, best practices, library comparisons, and solutions. Use read_file and list_files to understand the existing codebase. Provide a clear, structured summary of your findings with key facts, recommendations, and sources.",
          },
          coder: {
            role: "coder",
            systemPrompt: "You are an expert software developer. Write clean, efficient, production-ready code. Only output the code and brief explanations.",
          },
          reviewer: {
            role: "reviewer",
            systemPrompt: "You are a senior code reviewer. You receive code from the coder agent. Review it for bugs, security issues, performance problems, and best practices. Suggest specific improvements with code examples. At the end of your review, include exactly one line: [STATUS: APPROVED] if the code is good, or [STATUS: NEEDS_WORK] if it needs improvements.",
          },
        },
        orchestration: {
          maxConcurrentAgents: 3,
          timeout: 0,
        },
      };

      await saveConfig(config);
      logSuccess("Swarm initialized successfully!");
      logInfo(`Provider: ${options.provider}`);
      logInfo(`Model: ${model}`);
      logInfo("Config saved to .swarmrc.json");
    });
}
