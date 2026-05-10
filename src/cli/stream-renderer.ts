import chalk from "chalk";
import { StreamChunk } from "../providers/stream-types.js";
import { TPSDisplay } from "./tps-display.js";

/**
 * Renders streaming output from the LLM in a copilot-like style.
 * - Thinking/reasoning shown in dim gray with 💭 prefix
 * - Content streamed in normal color
 * - TPS meter shown at the end
 */
export class StreamRenderer {
  private roleTag: string;
  private tps: TPSDisplay;
  private inThinking = false;
  private thinkingStarted = false;
  private contentStarted = false;
  private fullContent = "";
  private fullThinking = "";

  constructor(role: string) {
    this.roleTag = chalk.cyan(`[${role}]`);
    this.tps = new TPSDisplay();
  }

  /**
   * Consume an async stream of chunks and render them to stdout.
   * Returns the full assembled response.
   */
  async render(
    stream: AsyncIterable<StreamChunk>
  ): Promise<{ content: string; thinking: string; tps: number; tokens: number }> {
    this.tps.start(this.roleTag);

    for await (const chunk of stream) {
      // Handle thinking tokens
      if (chunk.thinking) {
        this.tps.addTokens(1);
        if (!this.thinkingStarted) {
          this.thinkingStarted = true;
          this.inThinking = true;
          process.stdout.write(chalk.gray(`\n${this.roleTag} 💭 `));
        }
        this.fullThinking += chunk.thinking;
        process.stdout.write(chalk.dim.gray(chunk.thinking));
      }

      // Handle content tokens
      if (chunk.content) {
        // If we were in thinking mode and now content starts, close thinking block
        if (this.inThinking && !chunk.thinking) {
          this.inThinking = false;
          process.stdout.write(chalk.gray("\n"));
        }

        this.tps.addTokens(1);
        if (!this.contentStarted && !this.inThinking) {
          this.contentStarted = true;
          if (this.thinkingStarted) {
            process.stdout.write(chalk.gray(`\n${this.roleTag} `));
          }
        }

        this.fullContent += chunk.content;
        if (!this.inThinking) {
          process.stdout.write(chunk.content);
        }
      }

      // Handle done
      if (chunk.done) {
        // If still in thinking when done, close it
        if (this.inThinking) {
          this.inThinking = false;
          process.stdout.write(chalk.gray("\n"));
        }
        break;
      }
    }

    // Add newline after content
    if (this.contentStarted) {
      process.stdout.write("\n");
    }

    const stats = this.tps.stop();

    // Show TPS summary
    if (stats.tokens > 0) {
      process.stdout.write(
        chalk.gray(`  ${stats.tokens} tokens · ${stats.tps.toFixed(1)} tok/s\n`)
      );
    }

    return {
      content: this.fullContent,
      thinking: this.fullThinking,
      tps: stats.tps,
      tokens: stats.tokens,
    };
  }
}
