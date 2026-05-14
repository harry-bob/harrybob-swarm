import { BaseAgent, AgentConfig, AgentTask, AgentResult } from "./base.js";
import { LLMProvider, ChatMessage } from "../providers/types.js";
import { ToolRegistry } from "../tools/registry.js";
import chalk from "chalk";

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 10_000;

async function withRetry<T>(fn: () => Promise<T>, label: string, roleTag: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= MAX_RETRIES) break;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.yellow(`${roleTag} ⚠ ${label} failed (attempt ${attempt}/${MAX_RETRIES}): ${msg.slice(0, 120)}`));
      console.log(chalk.gray(`${roleTag}    Retrying in ${RETRY_DELAY_MS / 1000}s...`));
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  throw lastErr;
}

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
    case "run_command": {
      const timeoutSec = args.timeout != null ? Number(args.timeout) : 30;
      return `command: "${args.command}" (timeout: ${timeoutSec}s)`;
    }
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
  private toolCache = new Map<string, string>();
  private readonly READONLY_TOOLS = new Set(["read_file", "list_files", "web_search"]);
  private readonly MODIFYING_TOOLS = new Set(["write_file", "edit_file", "run_command"]);
  private modifiedFiles = new Set<string>();
  private readonly MAX_HISTORY = 32; // trigger compaction
  private readonly KEEP_RECENT = 8;  // keep last N messages intact
  private readonly KEEP_FIRST = 2;   // keep system + initial user message

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
    this.toolCache.clear();
    this.modifiedFiles.clear();
  }

  /**
   * Continue the existing conversation by adding a new user message.
   * Returns the agent's response (final text after all tool calls).
   */
  async continueChat(userMessage: string): Promise<{ output: string; tokenUsage: { prompt: number; completion: number } }> {
    // Only add user message if it's not empty
    if (userMessage.trim()) {
      this.history.push({ role: "user", content: userMessage });
    }
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
    this.toolCache.clear();
    this.modifiedFiles.clear();
  }

  /**
   * Returns true if the agent has called a tool that modifies files
   * (write_file, edit_file, or run_command) during this conversation.
   */
  hasModifiedFiles(): boolean {
    return this.modifiedFiles.size > 0;
  }

  /**
   * Returns the list of file paths modified or created by this agent.
   */
  getModifiedFiles(): string[] {
    return [...this.modifiedFiles];
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
   * Compact conversation history when it grows too long.
   * Keeps system prompt + initial task, keeps recent turns intact,
   * and summarizes middle turns to prevent context-window pressure.
   */
  private compactHistory(): void {
    if (this.history.length <= this.MAX_HISTORY) return;

    const keptHead = this.history.slice(0, this.KEEP_FIRST);
    const keptTail = this.history.slice(-this.KEEP_RECENT);
    const middle = this.history.slice(this.KEEP_FIRST, -this.KEEP_RECENT);

    // Summarize middle section by collapsing assistant+tool pairs
    const summaries: string[] = [];
    for (let i = 0; i < middle.length; i++) {
      const msg = middle[i];
      if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        const toolNames = msg.tool_calls.map((tc) => tc.name).join(", ");
        summaries.push(`Called tools: ${toolNames}`);
      } else if (msg.role === "user" && msg.content.startsWith('Tool "')) {
        // Truncate tool results in the middle to ~120 chars
        const short = msg.content.slice(0, 120).replace(/\n/g, " ");
        summaries.push(short + (msg.content.length > 120 ? "..." : ""));
      } else if (msg.role === "assistant") {
        const short = msg.content.slice(0, 120).replace(/\n/g, " ");
        summaries.push(short + (msg.content.length > 120 ? "..." : ""));
      }
    }

    const compacted: ChatMessage[] = [
      ...keptHead,
      {
        role: "system",
        content: `[Context compressed] Earlier steps summarized:\n${summaries.join("\n")}`,
      },
      ...keptTail,
    ];

    this.history = compacted;
  }
  private async runLoop(): Promise<{ output: string; tokenUsage: { prompt: number; completion: number } }> {
    const toolDefs = this.tools.getDefinitions();
    const roleTag = chalk.cyan(`[${this.config.role}]`);

    let totalPrompt = 0;
    let totalCompletion = 0;
    let finalContent = "";

    while (true) {
      // Prevent context-window bloat during long review loops
      this.compactHistory();

      // ── Stream the LLM response ──────────────────────────────
      let content = "";
      let thinking = "";
      let toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] | undefined;
      let evalCount = 0;
      let thinkingActive = false;
      let contentActive = false;
      let tokenCount = 0;
      const streamStart = Date.now();

      await withRetry(async () => {
        content = "";
        thinking = "";
        toolCalls = undefined;
        evalCount = 0;
        thinkingActive = false;
        contentActive = false;
        tokenCount = 0;

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
      }, "LLM stream", roleTag);

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

          // Check read-only tool cache
          const cacheKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
          if (this.READONLY_TOOLS.has(toolCall.name) && this.toolCache.has(cacheKey)) {
            const cached = this.toolCache.get(cacheKey)!;
            console.log(`${roleTag} ${chalk.yellow("⚙")} ${chalk.bold(toolCall.name)}(${argsStr}) ${chalk.gray("[cached]")}`);
            const preview = formatToolResult(toolCall.name, cached);
            console.log(`${roleTag} ${chalk.green("→")} ${preview.split("\n").join("\n" + roleTag + "   ")}`);
            return { id: toolCall.id, name: toolCall.name, output: cached };
          }

          console.log(`${roleTag} ${chalk.yellow("⚙")} ${chalk.bold(toolCall.name)}(${argsStr})`);

          let output: string;
          try {
            output = await this.tools.execute(toolCall.name, toolCall.arguments);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            output = `Error: ${msg}`;
          }

          // Track file-modifying tool usage
          if (this.MODIFYING_TOOLS.has(toolCall.name)) {
            const filePath = (toolCall.arguments.path as string) || "";
            if (filePath) this.modifiedFiles.add(filePath);
          }

          // Cache read-only results
          if (this.READONLY_TOOLS.has(toolCall.name)) {
            this.toolCache.set(cacheKey, output);
          }

          const preview = formatToolResult(toolCall.name, output);
          console.log(`${roleTag} ${chalk.green("→")} ${preview.split("\n").join("\n" + roleTag + "   ")}`);

          return { id: toolCall.id, name: toolCall.name, output };
        })
      );

      // Add tool results as user messages (workaround for Ollama cloud models)
      // Cloud models through Ollama don't properly process role: "tool" messages
      // so we embed results as user messages instead
      for (const result of results) {
        this.history.push({
          role: "user",
          content: `Tool "${result.name}" result:\n${result.output}`,
        });
      }
    }

    return {
      output: finalContent,
      tokenUsage: { prompt: totalPrompt, completion: totalCompletion },
    };
  }
}
