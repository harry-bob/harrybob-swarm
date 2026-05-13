import { LLMAgent } from "../agents/llm-agent.js";
import { LLMProvider, ChatMessage } from "../providers/types.js";
import { Tool } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { Sandbox } from "./sandbox.js";
import { createReadFileTool } from "./files.js";
import { createListFilesTool } from "./files.js";
import { createWebSearchTool } from "./web-search.js";
import chalk from "chalk";

/**
 * Creates a tool that spawns a researcher agent to gather information.
 * The leader can call this tool multiple times with different queries,
 * and the researcher will use web search, file reading, etc. to find answers.
 */
export function createResearchTool(
  provider: LLMProvider,
  model: string,
  sandbox: Sandbox
): Tool {
  return {
    definition: {
      name: "research",
      description:
        "Ask the researcher agent to gather information on a topic. The researcher can search the web, read files, and explore the codebase. Use this to look up API docs, best practices, library comparisons, error solutions, or any information needed to make informed decisions. You can call this multiple times with follow-up queries.",
      parameters: {
        query: {
          type: "string",
          description: "What to research — be specific (e.g., 'Flask vs FastAPI for REST APIs', 'how to handle auth in Express', 'find all TODO comments in the codebase')",
        },
      },
    },
    async execute(args): Promise<string> {
      const query = args.query as string;
      if (!query) return "Error: No research query provided";

      console.log(chalk.yellow(`    🔎 Researcher: "${query.slice(0, 80)}${query.length > 80 ? "..." : ""}"`));

      // Create researcher agent with its own tools
      const researcherTools = new ToolRegistry();
      researcherTools.register(createReadFileTool(sandbox));
      researcherTools.register(createListFilesTool(sandbox));
      researcherTools.register(createWebSearchTool());

      const researcher = new LLMAgent(
        {
          role: "researcher",
          systemPrompt:
            "You are a research agent. Your job is to gather information to answer a specific question. " +
            "Use web_search to find documentation, best practices, and solutions. " +
            "Use read_file and list_files to explore the existing codebase. " +
            "Provide a structured summary with these sections:\n" +
            "- FINDINGS: Key facts and technical details\n" +
            "- RECOMMENDATIONS: Suggested approach with pros/cons\n" +
            "- SOURCES: Relevant links or references\n" +
            "- CODE EXAMPLES: Minimal examples if applicable\n" +
            "Be thorough but concise. If you find multiple options, compare them.",
        },
        model,
        provider,
        researcherTools
      );

      try {
        const result = await researcher.execute({
          id: `research-${Date.now()}`,
          description: query,
          messages: [
            {
              role: "user",
              content: `Research the following and provide a comprehensive summary:\n\n${query}`,
            },
          ],
        });

        console.log(chalk.yellow(`    ✅ Research complete`));
        return result.output;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Research failed: ${msg}`;
      }
    },
  };
}
