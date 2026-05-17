import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_FILE = ".swarmrc.json";
const GLOBAL_DIR = join(homedir(), ".swarm");
const GLOBAL_CONFIG = join(GLOBAL_DIR, "config.json");

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

/** Credentials stored globally so they're available across directories. */
interface GlobalCredentials {
  [provider: string]: { apiKey?: string; baseURL?: string };
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

export async function loadConfig(): Promise<SwarmConfig | null> {
  // 1. Load local config
  const local = await readJson(join(process.cwd(), CONFIG_FILE));
  if (!local) return null;

  const config = local as unknown as SwarmConfig;

  // 2. Load global credentials and fill in missing apiKey/baseURL
  const global = await readJson(GLOBAL_CONFIG);
  if (global?.credentials) {
    const creds = (global.credentials as GlobalCredentials)[config.provider];
    if (creds) {
      if (!config.apiKey && creds.apiKey) config.apiKey = creds.apiKey;
      if (!config.baseURL && creds.baseURL) config.baseURL = creds.baseURL;
    }
  }

  return config;
}

export async function saveConfig(config: SwarmConfig): Promise<void> {
  // Save local config
  const configPath = join(process.cwd(), CONFIG_FILE);
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");

  // Also save credentials globally so they're available from other directories
  if (config.apiKey || config.baseURL) {
    try {
      await mkdir(GLOBAL_DIR, { recursive: true });
      const global = (await readJson(GLOBAL_CONFIG)) || {};
      if (!global.credentials) global.credentials = {};
      global.credentials[config.provider] = {
        ...(config.apiKey && { apiKey: config.apiKey }),
        ...(config.baseURL && { baseURL: config.baseURL }),
      };
      await writeFile(GLOBAL_CONFIG, JSON.stringify(global, null, 2), "utf-8");
    } catch {
      // non-fatal — global config is a convenience, not a requirement
    }
  }
}
