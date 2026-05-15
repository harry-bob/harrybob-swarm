import { getPackageVersion } from "./version.js";
import { withTimeout } from "./timeout.js";

interface UpdateInfo {
  current: string;
  latest: string;
}

/** Check npm registry for a newer version, wrapped in a short timeout. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const current = getPackageVersion();
  try {
    const latest = await withTimeout(fetchLatestVersion(), 3_000, "npm version check");
    if (latest && isNewer(latest, current)) {
      return { current, latest };
    }
  } catch {
    // silently ignore network failures
  }
  return null;
}

async function fetchLatestVersion(): Promise<string | null> {
  const res = await fetch("https://registry.npmjs.org/@harrybob/swarm-cli/latest", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { version?: string };
  return data.version || null;
}

/** Semantic-ish comparison: 0.1.5 > 0.1.4, 0.2.0 > 0.1.10 */
function isNewer(latest: string, current: string): boolean {
  const lp = latest.split(".").map(Number);
  const cp = current.split(".").map(Number);
  for (let i = 0; i < Math.max(lp.length, cp.length); i++) {
    const l = lp[i] || 0;
    const c = cp[i] || 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}
