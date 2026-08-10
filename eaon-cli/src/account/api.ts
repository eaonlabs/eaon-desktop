// Eaon account API client.
//
// Authenticates with the account API key already in config (`sk-eaon-…`) as a
// bearer token — the gateway accepts either that or a browser session on the
// read-only account routes (see backend/src/account-auth.js).
//
// Everything here returns a discriminated result rather than throwing. These
// views are a side panel in a coding tool: a flaky network should render "could
// not load" in a box, never take down the session the user was mid-task in.

import { EAON_GATEWAY_BASE_URL } from "../providers/eaon-hosted.js";

export interface AccountKey {
  id: string;
  name: string | null;
  key: string | null;
  usage: number;
  lastUsed: string | null;
  createdAt: string | null;
  revoked?: boolean;
}

export interface UsageTotals {
  requests: number;
  ok: number;
  errors: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  successRate: number;
  errorRate: number;
  avgLatencyMs: number;
  avgTokensPerRequest: number;
}

export interface UsageDay {
  day: string;
  requests: number;
  ok: number;
  errors: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  avgLatencyMs: number;
}

export interface UsageModel {
  id: string;
  req: number;
  tokens: number;
}

export interface BetaBudgetModel {
  id: string;
  name: string;
  dailyTokens: number;
  tokensLeft: number | null;
}

export interface BetaBudget {
  percentUsed: number;
  percentRemaining: number;
  exhausted: boolean;
  models: BetaBudgetModel[];
  unavailable?: boolean;
}

export interface AccountUsage {
  windows: Record<"today" | "week" | "month" | "year" | "all", UsageTotals>;
  series: UsageDay[];
  models: UsageModel[];
  plan: { id: string; name: string } | null;
  betaBudget: BetaBudget | null;
  quota:
    | { dailyTokens: number; usedToday: number; remaining: number; percentUsed: number }
    | { dailyTokens: null; usedToday: number; unlimited: true };
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

function base(): string {
  return EAON_GATEWAY_BASE_URL.replace(/\/v1\/?$/, "");
}

async function get<T>(pathname: string, apiKey: string, timeoutMs = 15_000): Promise<Result<T>> {
  if (!apiKey) {
    return { ok: false, error: "No Eaon API key configured. Run /link or set one in Settings." };
  }
  if (!apiKey.trim().toLowerCase().startsWith("sk-eaon-")) {
    // Worth saying plainly: a hosted key authenticates chat but has no account
    // behind it, so these views would 401 with a confusing "sign in" message.
    return {
      ok: false,
      error: "Account views need an Eaon account key (sk-eaon-…). The configured key isn't one.",
    };
  }

  try {
    const res = await fetch(`${base()}${pathname}`, {
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        Accept: "application/json",
        "User-Agent": "eaon-cli (+https://eaon.dev)",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      return { ok: false, error: `Gateway returned non-JSON (HTTP ${res.status}).` };
    }

    const payload = body as { data?: T; error?: { message?: string; code?: string } };

    if (!res.ok) {
      const code = payload.error?.code;
      // Translate the two failures a CLI user can actually act on.
      if (code === "invite_required") {
        return { ok: false, error: "This account needs an invite code. Redeem one at eaon.dev." };
      }
      if (res.status === 401) {
        return { ok: false, error: "That API key was rejected. Create a new one at eaon.dev." };
      }
      return { ok: false, error: payload.error?.message || `HTTP ${res.status}` };
    }

    if (payload.data === undefined) return { ok: false, error: "Gateway response had no data." };
    return { ok: true, data: payload.data };
  } catch (err) {
    const e = err as Error;
    const timedOut = e.name === "TimeoutError" || /abort/i.test(e.message);
    return { ok: false, error: timedOut ? "Timed out reaching api.eaon.dev." : e.message };
  }
}

export function fetchAccountKeys(apiKey: string): Promise<Result<AccountKey[]>> {
  return get<AccountKey[]>("/v1/account/keys", apiKey);
}

export function fetchAccountUsage(apiKey: string): Promise<Result<AccountUsage>> {
  // Scanning a month of counters server-side is the slow one; give it room.
  return get<AccountUsage>("/v1/account/usage", apiKey, 25_000);
}

/** `sk-eaon-abc…wxyz`. Never print a key in full; the list view is shoulder-surfable. */
export function maskKey(key: string | null): string {
  const s = (key ?? "").trim();
  if (!s) return "••••••••";
  if (s.length <= 14) return `${s.slice(0, 4)}…`;
  return `${s.slice(0, 11)}…${s.slice(-4)}`;
}
