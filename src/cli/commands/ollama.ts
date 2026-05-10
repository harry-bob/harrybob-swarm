import { Command } from "commander";
import { OllamaProvider } from "../../providers/ollama.js";
import { loadConfig } from "../../config/config.js";
import { logInfo, logError, logSuccess } from "../../utils/logger.js";

export function ollamaCommand(program: Command): void {
  const ollama = program
    .command("ollama")
    .description("Ollama-related commands");

  // swarm ollama list — list available models
  ollama
    .command("list")
    .description("List available Ollama models")
    .option("--base-url <url>", "Ollama API base URL")
    .action(async (options) => {
      const config = await loadConfig();
      const baseURL = options.baseUrl || config?.baseURL || "http://localhost:11434";

      logInfo(`Connecting to Ollama at ${baseURL}...`);

      try {
        const provider = new OllamaProvider({ baseURL });
        const models = await provider.listModels();

        if (models.length === 0) {
          logInfo("No models found. Use `ollama pull <model>` to download one.");
          return;
        }

        console.log("\n📦 Available Ollama Models:");
        console.log("─".repeat(40));
        models.forEach((m) => console.log(`  • ${m}`));
        console.log("─".repeat(40));
        console.log(`Total: ${models.length} model(s)\n`);
      } catch (error) {
        logError(`Failed to connect to Ollama: ${error}`);
        logInfo("Make sure Ollama is running: `ollama serve`");
      }
    });

  // swarm ollama pull — pull a model
  ollama
    .command("pull <model>")
    .description("Pull/download an Ollama model")
    .option("--base-url <url>", "Ollama API base URL")
    .action(async (model: string, options) => {
      const config = await loadConfig();
      const baseURL = options.baseUrl || config?.baseURL || "http://localhost:11434";

      logInfo(`Pulling model: ${model}...`);

      try {
        const provider = new OllamaProvider({ baseURL });
        await provider.pullModel(model);
        logSuccess(`Model "${model}" pulled successfully!`);
      } catch (error) {
        logError(`Failed to pull model: ${error}`);
      }
    });

  // swarm ollama test — quick test of the connection
  ollama
    .command("test")
    .description("Test Ollama connection with a simple prompt")
    .option("--model <model>", "Model to test with")
    .option("--base-url <url>", "Ollama API base URL")
    .action(async (options) => {
      const config = await loadConfig();
      const baseURL = options.baseUrl || config?.baseURL || "http://localhost:11434";
      const model = options.model || config?.model || "llama3.1";

      logInfo(`Testing Ollama with model: ${model}...`);

      try {
        const provider = new OllamaProvider({ baseURL, model });
        const response = await provider.chat({
          model,
          messages: [{ role: "user", content: "Say hello in one sentence." }],
        });

        logSuccess("Response:");
        console.log(`  ${response.content}`);
        console.log(`\n  Tokens — prompt: ${response.usage.prompt}, completion: ${response.usage.completion}`);
      } catch (error) {
        logError(`Connection failed: ${error}`);
        logInfo("Make sure Ollama is running: `ollama serve`");
      }
    });
}
