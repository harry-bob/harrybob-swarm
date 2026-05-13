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
        // Check OLLAMA_MODEL env first
        if (process.env.OLLAMA_MODEL) {
          model = process.env.OLLAMA_MODEL;
          logInfo(`Using model from OLLAMA_MODEL: ${model}`);
        } else {
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
            systemPrompt: "You are a research agent. Your job is to gather information to help the architect plan effectively. Use web_search to find documentation, best practices, library comparisons, and solutions. Use read_file and list_files to understand the existing codebase. Provide a structured summary with these sections:\n- FINDINGS: Key facts and technical details\n- RECOMMENDATIONS: Suggested approach with pros/cons\n- SOURCES: Relevant links or references\n- CODE EXAMPLES: Minimal examples if applicable",
          },
          coder: {
            role: "coder",
            systemPrompt: "You are an expert software developer. You write clean, efficient, production-ready code. Before writing, you explore the codebase to understand existing patterns. You implement complete solutions with proper error handling, then verify your work by running tests or the code itself. You do not leave TODOs or placeholder code.",
          },
          reviewer: {
            role: "reviewer",
            systemPrompt: "You are a senior code reviewer at a top-tier tech company. You inspect code for correctness, security vulnerabilities, performance issues, and edge cases. You run tests or verification commands as evidence. Your feedback is specific and actionable, citing files and lines. At the end of your review, include exactly one line: [STATUS: APPROVED] if the code is good, or [STATUS: NEEDS_WORK] if improvements are required.",
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
