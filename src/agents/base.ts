export interface AgentConfig {
  role: string;
  systemPrompt: string;
  model?: string;
}

export interface AgentMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AgentTask {
  id: string;
  description: string;
  context?: string;
  messages: AgentMessage[];
}

export interface AgentResult {
  taskId: string;
  agentRole: string;
  output: string;
  tokenUsage: {
    prompt: number;
    completion: number;
  };
  duration: number;
}

export abstract class BaseAgent {
  protected config: AgentConfig;
  protected model: string;

  constructor(config: AgentConfig, model: string) {
    this.config = config;
    this.model = model;
  }

  abstract execute(task: AgentTask): Promise<AgentResult>;

  getRole(): string {
    return this.config.role;
  }

  protected buildMessages(task: AgentTask): AgentMessage[] {
    const messages: AgentMessage[] = [
      { role: "system", content: this.config.systemPrompt },
    ];

    if (task.context) {
      messages.push({
        role: "system",
        content: `Context:\n${task.context}`,
      });
    }

    messages.push(...task.messages);
    return messages;
  }
}
