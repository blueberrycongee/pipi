import { runHelper } from "./sidecar";

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsageAgentRow {
  agentId: string;
  sessions: number;
  messages: number;
  tokens: TokenTotals;
  cost: number;
}

export interface UsageModelRow {
  provider: string;
  model: string;
  messages: number;
  tokens: TokenTotals;
  cost: number;
}

export interface UsageDay {
  day: string;
  tokens: number;
  cost: number;
}

/** Token use and cost accumulated across every saved session (`sidecar/usage-stats.mjs`). */
export interface UsageStats {
  scannedAt: number;
  totals: TokenTotals & { cost: number; sessions: number; userMessages: number; assistantMessages: number; toolCalls: number };
  agents: UsageAgentRow[];
  models: UsageModelRow[];
  daily: UsageDay[];
}

export const EMPTY_USAGE: UsageStats = {
  scannedAt: 0,
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, sessions: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0 },
  agents: [],
  models: [],
  daily: [],
};

/** Scans all saved session files on disk; a fresh figure every call. */
export async function usageStats(): Promise<UsageStats> {
  const out = await runHelper("usage-stats.mjs", []);
  const parsed: unknown = JSON.parse(out || "null");
  return parsed && typeof parsed === "object" ? (parsed as UsageStats) : EMPTY_USAGE;
}
