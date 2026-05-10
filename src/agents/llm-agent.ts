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

  constructor(config: AgentConfig, model: string, provider: LLMProvider, tools: ToolRegistry) {
    super(config, model);
    this.provider = provider;
    this.tools = tools;
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const startTime = Date.now();
    const messages: ChatMessage[] = this.buildMessages(task);
    const toolDefs = this.tools.getDefinitions();
    const roleTag = chalk.cyan(`[${this.config.role}]`);

    let totalPrompt = 0;
    let totalCompletion = 0;
    let finalContent = "";
    let rounds = 0;
    let hasModifiedFiles = false;
    let rePromptCount = 0;
    const MAX_REPROMPTS = 5;

    while (true) {
      rounds++;

      // ── Stream the LLM response ──────────────────────────────
      let content = "";
      let thinking = "";
      let toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] | undefined;
      let evalCount = 0;
      let evalDurationNs = 0;
      let thinkingActive = false;
      let contentActive = false;
      let tokenCount = 0;
      const streamStart = Date.now();

      const stream = this.provider.chatStream({
        model: this.model,
        messages,
        tools: toolDefs,
      });

      for await (const chunk of stream) {
        // ── Capture tool calls from stream ──
        if (chunk.tool_calls) {
          toolCalls = chunk.tool_calls;
        }

        // ── Thinking/reasoning tokens ──
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

        // ── Content tokens ──
        if (chunk.content) {
          tokenCount++;
          // Transition from thinking to content
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

        // ── Final chunk ──
        if (chunk.done) {
          if (thinkingActive) thinkingActive = false;
          if (chunk.tokenCount) evalCount = chunk.tokenCount;
          if (chunk.durationNs) evalDurationNs = chunk.durationNs;
        }
      }

      // Close any open line
      if (thinkingActive || contentActive) {
        process.stdout.write("\n");
      }

      // Show TPS summary for this round
      const streamDuration = Date.now() - streamStart;
      if (tokenCount > 0 && streamDuration > 0) {
        const tps = tokenCount / (streamDuration / 1000);
        process.stdout.write(
          chalk.gray(`  ${roleTag} ${tokenCount} tokens · ${tps.toFixed(1)} tok/s\n`)
        );
      }

      totalCompletion += evalCount || tokenCount;

      // ── Handle tool calls ─────────────────────────────────────
      if (!toolCalls || toolCalls.length === 0) {
        if (!hasModifiedFiles && rePromptCount < MAX_REPROMPTS) {
          rePromptCount++;
          messages.push({
            role: "user",
            content: "You have NOT created or modified any files yet. You MUST call write_file or edit_file RIGHT NOW to create the actual code. Do not describe what you plan to do — call write_file immediately with the complete code.",
          });
          continue;
        }
        finalContent = content;
        break;
      }

      // Add assistant message with tool calls to history
      messages.push({
        role: "assistant",
        content,
        tool_calls: toolCalls,
      });

      // Execute each tool call
      for (const toolCall of toolCalls) {
        const argsStr = formatToolArgs(toolCall.name, toolCall.arguments);
        console.log(`${roleTag} ${chalk.yellow("⚙")} ${chalk.bold(toolCall.name)}(${argsStr})`);

        // Track if actual work was done (not just reading)
        if (toolCall.name === "write_file" || toolCall.name === "edit_file" || toolCall.name === "run_command") {
          hasModifiedFiles = true;
          rePromptCount = 0;
        }

        let output: string;
        try {
          output = await this.tools.execute(toolCall.name, toolCall.arguments);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          output = `Error: ${msg}`;
        }

        const preview = formatToolResult(toolCall.name, output);
        console.log(`${roleTag} ${chalk.green("→")} ${preview.split("\n").join("\n" + roleTag + "   ")}`);

        messages.push({
          role: "tool",
          content: output,
          tool_call_id: toolCall.id,
        });
      }
    }



    const duration = Date.now() - startTime;

    return {
      taskId: task.id,
      agentRole: this.config.role,
      output: finalContent,
      tokenUsage: {
        prompt: totalPrompt,
        completion: totalCompletion,
      },
      duration,
    };
  }
}
