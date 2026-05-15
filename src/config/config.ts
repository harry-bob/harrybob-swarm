import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_FILE = ".swarmrc.json";

export interface SwarmConfig {
  version: string;
  provider: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
  agents: Record<string, { role: string; systemPrompt: string }>;
  orchestration: {
    maxConcurrentAgents: number;
    timeout: number;
  };
}

export async function loadConfig(): Promise<SwarmConfig | null> {
  try {
    const configPath = join(process.cwd(), CONFIG_FILE);
    const data = await readFile(configPath, "utf-8");
    return JSON.parse(data) as SwarmConfig;
  } catch {
    return null;
  }
}

export async function saveConfig(config: SwarmConfig): Promise<void> {
  const configPath = join(process.cwd(), CONFIG_FILE);
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}
