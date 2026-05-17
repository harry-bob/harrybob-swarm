import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { TaskPlan } from "./types.js";

export interface SessionContext {
  lastTask: string;
  lastPlan?: string;
  filesCreated: string[];
  timestamp: number;
  /** Full task plan (persisted so --continue can skip re-planning) */
  plan?: TaskPlan;
  /** IDs of subtasks that completed successfully */
  completed?: string[];
}

const SESSION_FILE = ".swarm-session.json";

export async function saveSession(ctx: SessionContext): Promise<void> {
  const sessionPath = join(process.cwd(), SESSION_FILE);
  await writeFile(sessionPath, JSON.stringify(ctx, null, 2), "utf-8");
}

export async function loadSession(): Promise<SessionContext | null> {
  const sessionPath = join(process.cwd(), SESSION_FILE);
  try {
    await access(sessionPath);
    const data = await readFile(sessionPath, "utf-8");
    return JSON.parse(data) as SessionContext;
  } catch {
    return null;
  }
}
