import { LLMProvider, ChatMessage } from "../providers/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { TaskPlan, Subtask } from "./types.js";
import chalk from "chalk";

const ARCHITECT_SYSTEM_PROMPT = `You are the Leader/Architect agent. Your job is to analyze a user's request, investigate the codebase, and break the work into clear, actionable subtasks that coding agents can execute independently.

## Your Tools
You have ONLY these tools:
- read_file — read file contents
- list_files — list files and directories
- run_command — execute shell commands
- ask_user_question — ask the user for clarification (if request is ambiguous)
- web_search — search the web for documentation or best practices

## Workflow (MUST follow this order)
1. INVESTIGATE: Use list_files and read_file to understand the project structure and existing code relevant to the task.
2. REASON: Think step by step about what needs to change. Identify files to modify, new files to create, and dependencies between changes.
3. CLARIFY: If the request is ambiguous, has missing details, or could be interpreted multiple ways, use ask_user_question BEFORE creating the plan.
4. PLAN: Produce a JSON plan with subtasks.

## Subtask Design Rules
- Break into 1-5 subtasks (prefer fewer, larger tasks unless complexity demands more).
- Each subtask must be self-contained with a SPECIFIC description including exact file names, function names, and key requirements.
- Only add dependencies when truly necessary. Ensure the dependency graph is acyclic.
- A subtask should be completable by a single coder agent using file tools.
- If the task is simple enough for one agent, return exactly one subtask with no dependencies.

## Output Format
You MUST respond with ONLY a valid JSON object — no markdown fences, no preamble, no explanation before or after:
{
  "goal": "Brief summary of the overall goal",
  "subtasks": [
    {
      "id": "task-1",
      "title": "Short title",
      "description": "Detailed description of what to implement, including exact file names, function names, and key requirements. Be specific enough that a developer can implement it without asking questions.",
      "dependencies": []
    }
  ]
}`;

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 10_000;

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= MAX_RETRIES) break;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.yellow(`[architect] ⚠ ${label} failed (attempt ${attempt}/${MAX_RETRIES}): ${msg.slice(0, 120)}`));
      console.log(chalk.gray(`[architect]    Retrying in ${RETRY_DELAY_MS / 1000}s...`));
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  throw lastErr;
}

export class ArchitectAgent {
  private provider: LLMProvider;
  private model: string;
  private tools: ToolRegistry;

  constructor(provider: LLMProvider, model: string, tools: ToolRegistry) {
    this.provider = provider;
    this.model = model;
    this.tools = tools;
  }

  async plan(taskDescription: string): Promise<TaskPlan> {
    console.log(chalk.magenta("\n🧠 Leader analyzing task..."));

    const messages: ChatMessage[] = [
      { role: "system", content: ARCHITECT_SYSTEM_PROMPT },
      { role: "user", content: taskDescription },
    ];

    const toolDefs = this.tools.getDefinitions();
    let rounds = 0;

    // Architect can also use tools (read project, list files) to understand context
    while (true) {
      rounds++;

      const response = await withRetry(() => this.provider.chat({
        model: this.model,
        messages,
        tools: toolDefs,
      }), "chat");

      // If the architect wants to use tools first (e.g., inspect existing codebase)
      if (response.tool_calls && response.tool_calls.length > 0) {
        messages.push({
          role: "assistant",
          content: response.content || "",
          tool_calls: response.tool_calls,
        });

        for (const toolCall of response.tool_calls) {
          const argsStr = Object.entries(toolCall.arguments).map(([k, v]) => `${k}: "${v}"`).join(", ");
          console.log(chalk.magenta(`[architect] ⚙ ${toolCall.name}(${argsStr})`));

          let output: string;
          try {
            output = await this.tools.execute(toolCall.name, toolCall.arguments);
          } catch (err: unknown) {
            output = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }

          // Workaround for Ollama cloud models: embed tool results as user messages
          messages.push({
            role: "user",
            content: `Tool "${toolCall.name}" result:\n${output}`,
          });
        }
        continue;
      }

      // Parse the plan from the response
      const plan = this.parsePlan(response.content || "", taskDescription);
      return plan;
    }

    // Fallback: single subtask
    return {
      goal: taskDescription,
      subtasks: [{
        id: "task-1",
        title: "Implement task",
        description: taskDescription,
        dependencies: [],
      }],
    };
  }

  /**
   * Quick re-planning pass — uses the existing tools to evaluate and adjust the plan.
   */
  async replan(prompt: string): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: ARCHITECT_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ];

    const response = await withRetry(() => this.provider.chat({
      model: this.model,
      messages,
      responseFormat: { type: "json_object" },
    }), "replan");

    return response.content || "NO CHANGES";
  }

  private parsePlan(content: string, fallback: string): TaskPlan {
    try {
      // Try to extract JSON from the response
      let jsonStr = content.trim();

      // If wrapped in markdown code block, extract it
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }

      const parsed = JSON.parse(jsonStr);

      // Validate structure
      if (!parsed.goal || !Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) {
        throw new Error("Invalid plan structure");
      }

      // Validate and normalize each subtask
      const subtasks: Subtask[] = parsed.subtasks.map((st: Record<string, unknown>, i: number) => ({
        id: (st.id as string) || `task-${i + 1}`,
        title: (st.title as string) || `Task ${i + 1}`,
        description: (st.description as string) || (st.title as string) || "",
        dependencies: Array.isArray(st.dependencies) ? st.dependencies as string[] : [],
      }));

      return {
        goal: parsed.goal as string,
        subtasks,
      };
    } catch {
      // Fallback: single subtask
      return {
        goal: fallback,
        subtasks: [{
          id: "task-1",
          title: "Implement task",
          description: fallback,
          dependencies: [],
        }],
      };
    }
  }
}
