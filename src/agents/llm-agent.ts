import { BaseAgent, AgentConfig, AgentTask, AgentResult } from "./base.js";
import { LLMProvider, ChatMessage } from "../providers/types.js";
import { ToolRegistry } from "../tools/registry.js";
import chalk from "chalk";

function formatToolArgs(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
      return `path: "${args.path}"`;
    case "write_file":
      return `path: "${args.path}"`;
    case "edit_file":
      return `path: "${args.path}"`;
    case "list_files":
      return `path: "${args.path || "."}"`;
    case "run_command":
      return `command: "${args.command}"`;
    case "ask_user_question":
      return `question: "${(args.question as string).slice(0, 60)}..."`;
    default:
      return Object.entries(args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
  }
}

function formatToolResult(name: string, output: string): string {
  const lines = output.split("\n");
  const preview = lines.slice(0, 5).join("\n");
  const truncated = lines.length > 5 ? `\n${chalk.gray(`  ... (${lines.length - 5} more lines)`)}` : "";
  return preview + truncated;
}

export class LLMAgent extends BaseAgent {
  private provider: LLMProvider;
  private tools: ToolRegistry;
  private history: ChatMessage[] = [];

  constructor(config: AgentConfig, model: string, provider: LLMProvider, tools: ToolRegistry) {
    super(config, model);
    this.provider = provider;
    this.tools = tools;
  }

  /**
   * Start a new conversation with a task. Initializes history with system prompt + task.
   */
  startTask(task: AgentTask): void {
    this.history = this.buildMessages(task);
  }

  /**
   * Continue the existing conversation by adding a new user message.
   * Returns the agent's response (final text after all tool calls).
   */
  async continueChat(userMessage: string): Promise<{ output: string; tokenUsage: { prompt: number; completion: number } }> {
    this.history.push({ role: "user", content: userMessage });
    return this.runLoop();
  }

  /**
   * Get the current conversation history (for passing to reviewer/coder).
   */
  getHistory(): ChatMessage[] {
    return [...this.history];
  }

  /**
   * Reset conversation history (for new subtask).
   */
  resetHistory(): void {
    this.history = [];
  }

  /**
   * One-shot execute (creates fresh history each time — for backward compat).
   */
  async execute(task: AgentTask): Promise<AgentResult> {
    const startTime = Date.now();
    this.history = this.buildMessages(task);
    const { output, tokenUsage } = await this.runLoop();
    return {
      taskId: task.id,
      agentRole: this.config.role,
      output,
      tokenUsage,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Core LLM loop: stream response, execute tool calls (in parallel), repeat.
   * Operates on this.history — appends messages in place.
   */
  private async runLoop(): Promise<{ output: string; tokenUsage: { prompt: number; completion: number } }> {
    const toolDefs = this.tools.getDefinitions();
    const roleTag = chalk.cyan(`[${this.config.role}]`);

    let totalPrompt = 0;
    let totalCompletion = 0;
    let finalContent = "";

    while (true) {
      // ── Stream the LLM response ──────────────────────────────
      let content = "";
      let thinking = "";
      let toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] | undefined;
      let evalCount = 0;
      let thinkingActive = false;
      let contentActive = false;
      let tokenCount = 0;
      const streamStart = Date.now();

      const stream = this.provider.chatStream({
        model: this.model,
        messages: this.history,
        tools: toolDefs,
      });

      for await (const chunk of stream) {
        if (chunk.tool_calls) {
          toolCalls = chunk.tool_calls;
        }

        if (chunk.thinking) {
          tokenCount++;
          if (!thinkingActive) {
            thinkingActive = true;
            contentActive = false;
            process.stdout.write(chalk.dim(`\n${roleTag} 💭 `));
          }
          thinking += chunk.thinking;
          process.stdout.write(chalk.dim(chunk.thinking));
        }

        if (chunk.content) {
          tokenCount++;
          if (thinkingActive) {
            thinkingActive = false;
            contentActive = true;
            process.stdout.write(`\n${roleTag} `);
          } else if (!contentActive) {
            contentActive = true;
            process.stdout.write(`\n${roleTag} `);
          }
          content += chunk.content;
          process.stdout.write(chunk.content);
        }

        if (chunk.done) {
          if (thinkingActive) thinkingActive = false;
          if (chunk.tokenCount) evalCount = chunk.tokenCount;
        }
      }

      if (thinkingActive || contentActive) {
        process.stdout.write("\n");
      }

      const streamDuration = Date.now() - streamStart;
      if (tokenCount > 0 && streamDuration > 0) {
        const tps = tokenCount / (streamDuration / 1000);
        process.stdout.write(
          chalk.gray(`  ${roleTag} ${tokenCount} tokens · ${tps.toFixed(1)} tok/s\n`)
        );
      }

      totalCompletion += evalCount || tokenCount;

      // ── No tool calls → done ─────────────────────────────────
      if (!toolCalls || toolCalls.length === 0) {
        finalContent = content;
        // Store assistant response in history
        this.history.push({ role: "assistant", content });
        break;
      }

      // Add assistant message with tool calls to history
      this.history.push({
        role: "assistant",
        content,
        tool_calls: toolCalls,
      });

      // ── Execute ALL tool calls in parallel ───────────────────
      const results = await Promise.all(
        toolCalls.map(async (toolCall) => {
          const argsStr = formatToolArgs(toolCall.name, toolCall.arguments);
          console.log(`${roleTag} ${chalk.yellow("⚙")} ${chalk.bold(toolCall.name)}(${argsStr})`);

          let output: string;
          try {
            output = await this.tools.execute(toolCall.name, toolCall.arguments);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            output = `Error: ${msg}`;
          }

          const preview = formatToolResult(toolCall.name, output);
          console.log(`${roleTag} ${chalk.green("→")} ${preview.split("\n").join("\n" + roleTag + "   ")}`);

          return { id: toolCall.id, name: toolCall.name, output };
        })
      );

      // Add all tool results to history
      for (const result of results) {
        this.history.push({
          role: "tool",
          content: result.output,
          tool_call_id: result.id,
        });
      }
    }

    return {
      output: finalContent,
      tokenUsage: { prompt: totalPrompt, completion: totalCompletion },
    };
  }
}
