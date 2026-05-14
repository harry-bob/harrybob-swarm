import { Tool } from "./types.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

function getTavilyKey(): string | undefined {
  // Try process.env first
  const envKey = process.env.TAVILY_API_KEY;
  if (envKey) return envKey;

  // Fallback: read .env manually in case dotenv wasn't invoked
  const envPath = join(cwd(), ".env");
  if (!existsSync(envPath)) return undefined;
  try {
    const content = readFileSync(envPath, "utf-8");
    const match = content.match(/^TAVILY_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* ignore */ }
  return undefined;
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyResponse {
  results: TavilyResult[];
  answer?: string;
}

export function createWebSearchTool(): Tool {
  return {
    definition: {
      name: "web_search",
      description: "Search the web for information. Returns relevant results with titles, URLs, and content snippets. Use for finding documentation, APIs, examples, solutions to errors, etc.",
      parameters: {
        query: {
          type: "string",
          description: "The search query",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results to return (default: 5)",
          required: false,
        },
      },
    },
    async execute(args) {
      const apiKey = getTavilyKey();
      if (!apiKey) {
        return "Error: TAVILY_API_KEY is missing. Ensure .env contains TAVILY_API_KEY=tvly-... in the directory where you run swarm.";
      }
      if (apiKey.length < 20) {
        return `Error: TAVILY_API_KEY looks too short (${apiKey.length} chars, expected 40+). It may be a placeholder.`;
      }

      const query = args.query as string;
      const maxResults = (args.maxResults as number) || 5;

      try {
        const response = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            search_depth: "basic",
            max_results: maxResults,
            include_answer: true,
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          return `Search error: ${response.status} - ${error}`;
        }

        const data = (await response.json()) as TavilyResponse;

        let output = "";

        // Include Tavily's AI-generated answer if available
        if (data.answer) {
          output += `## Answer\n${data.answer}\n\n`;
        }

        // Include search results
        if (data.results && data.results.length > 0) {
          output += `## Results\n\n`;
          for (const result of data.results) {
            output += `### ${result.title}\n`;
            output += `URL: ${result.url}\n`;
            output += `${result.content}\n\n`;
          }
        } else {
          output += "No results found.";
        }

        return output.trim();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Search error: ${message}`;
      }
    },
  };
}
