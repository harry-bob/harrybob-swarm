import { LLMProvider, ChatMessage } from "../providers/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { TaskPlan, Subtask } from "./types.js";
import chalk from "chalk";

const ARCHITECT_SYSTEM_PROMPT = `You are the Leader/Architect agent. Your job is to analyze a user's request and break it down into clear, actionable subtasks that can be worked on by coding agents.

You have a research tool that lets you delegate research to a researcher agent. Use it to gather information BEFORE creating the plan. You can call it multiple times with different or follow-up queries.

Research workflow:
1. First, think about what information you need to make informed decisions
2. Use the research tool to look up documentation, best practices, library comparisons, etc.
3. Review the results — if you need more details, call research again with a follow-up query
4. Once you have enough information, create the plan

Examples of when to research:
- User asks to build something — research the best frameworks/libraries
- User reports a bug — research the error message or root cause
- User wants to add a feature — research existing patterns and best practices
- Technical decisions needed — research pros/cons of different approaches

Before creating the plan, also consider whether the request is clear enough. If the task is ambiguous, has missing details, or could be interpreted in multiple ways, use the ask_user_question tool to ask the user for clarification BEFORE generating the plan.

Examples of when to ask:
- "Build an app" — what kind of app? what features? what language?
- "Fix the bug" — which bug? what's the expected behavior?
- "Add authentication" — what type? OAuth, JWT, session-based?
- "Make it faster" — what's slow? what are the constraints?

Each subtask should be:
- Self-contained with a clear description
- Specific enough that a developer can implement it independently
- Assigned dependencies if it needs other subtasks to complete first

You MUST respond with ONLY a valid JSON object in this exact format:
{
  "goal": "Brief summary of the overall goal",
  "subtasks": [
    {
      "id": "task-1",
      "title": "Short title",
      "description": "Detailed description of what to implement, including file names and key requirements",
      "dependencies": []
    },
    {
      "id": "task-2",
      "title": "Short title",
      "description": "Detailed description...",
      "dependencies": ["task-1"]
    }
  ]
}

Guidelines:
- Break into 1-5 subtasks (prefer fewer, larger tasks unless complexity demands more)
- Only add dependencies when truly necessary
- Include specific file names, function names, and technical details in descriptions
- If the request is simple enough for one agent, return a single subtask with no dependencies
- Each subtask should be completable by a single coder agent with tools
- DO NOT include any text before or after the JSON. ONLY output the JSON.`;

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

      const response = await this.provider.chat({
        model: this.model,
        messages,
        tools: toolDefs,
      });

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



          messages.push({
            role: "tool",
            content: output,
            tool_call_id: toolCall.id,
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
