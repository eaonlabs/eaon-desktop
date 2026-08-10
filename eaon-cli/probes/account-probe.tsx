// Renders the account panel against a stubbed gateway so each tab can be
// asserted on without a live account key.
//
// The fetch stub is the point: the happy path needs a real `sk-eaon-…` key that
// this machine does not have, so the shapes the gateway returns are pinned here
// against backend/src/account-usage.js and account-keys.js instead.
import React from "react";
import { render } from "ink";
import { EventEmitter } from "node:events";
import { applyTheme } from "../src/ui/theme.js";
import { maskKey } from "../src/account/api.js";

const KEY = "sk-eaon-1111222233334444555566667777";

const KEYS_PAYLOAD = {
  data: [
    { id: "k1", name: "laptop", key: KEY, usage: 1423, lastUsed: new Date(Date.now() - 3600_000).toISOString(), createdAt: null },
    { id: "k2", name: "ci", key: "sk-eaon-aaaabbbbccccddddeeeeffff0000", usage: 0, lastUsed: null, createdAt: null },
  ],
};

function days(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 6, 12 + i));
    const tokens = i === n - 1 ? 42_000 : Math.round(3000 + Math.sin(i) * 2500 + i * 400);
    return {
      day: d.toISOString().slice(0, 10),
      requests: Math.max(1, Math.round(tokens / 800)),
      ok: Math.max(1, Math.round(tokens / 850)),
      errors: i % 9 === 0 ? 1 : 0,
      tokens,
      promptTokens: Math.round(tokens * 0.4),
      completionTokens: Math.round(tokens * 0.6),
      avgLatencyMs: 900 + (i % 5) * 220,
    };
  });
}

const totals = (tokens: number, requests: number) => ({
  requests,
  ok: requests - 1,
  errors: 1,
  tokens,
  promptTokens: Math.round(tokens * 0.4),
  completionTokens: Math.round(tokens * 0.6),
  successRate: ((requests - 1) / requests) * 100,
  errorRate: (1 / requests) * 100,
  avgLatencyMs: 1240,
  avgTokensPerRequest: Math.round(tokens / requests),
});

const USAGE_PAYLOAD = {
  data: {
    windows: {
      today: totals(42_000, 51),
      week: totals(210_500, 260),
      month: totals(884_120, 1104),
      year: totals(2_450_990, 3010),
      all: totals(2_450_990, 3010),
    },
    series: days(30),
    models: [
      { id: "kimi-k3", req: 210, tokens: 512_000 },
      { id: "deepseek-v4-flash", req: 640, tokens: 288_400 },
      { id: "glm-5.2", req: 120, tokens: 83_720 },
    ],
    plan: { id: "beta", name: "Eaon Beta" },
    betaBudget: {
      percentUsed: 61.4,
      percentRemaining: 38.6,
      exhausted: false,
      models: [
        { id: "kimi-k3", name: "Kimi K3", dailyTokens: 63_578, tokensLeft: 24_541 },
        { id: "grok-4.5", name: "Grok 4.5", dailyTokens: 72_820, tokensLeft: 28_108 },
        { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", dailyTokens: 18_205_701, tokensLeft: 7_027_400 },
      ],
    },
    quota: { dailyTokens: null, usedToday: 42_000, unlimited: true },
  },
};

// Stub fetch before AccountView is imported, so its module-level import of the
// api client closes over the stubbed global.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL) => {
  const u = String(url);
  const body = u.includes("/account/keys") ? KEYS_PAYLOAD : u.includes("/account/usage") ? USAGE_PAYLOAD : null;
  if (!body) return new Response("not found", { status: 404 });
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { AccountView } = await import("../src/ui/AccountView.js");

class FakeOut extends EventEmitter {
  columns = 100;
  rows = 44;
  isTTY = true;
  frames: string[] = [];
  write(s: string): boolean {
    this.frames.push(s);
    return true;
  }
}
/** Ink 5 consumes stdin via the `readable` event + `stream.read()`, not `data`
 *  events — a FakeIn that only emitted `data` was silently ignored, and every
 *  keystroke assertion failed while the app itself was fine. So this queues
 *  chunks and hands them out through read(). */
class FakeIn extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setRawMode(): this { return this; }
  resume(): this { return this; }
  pause(): this { return this; }
  setEncoding(): this { return this; }
  unref(): this { return this; }
  ref(): this { return this; }
  read(): string | null {
    return this.queue.shift() ?? null;
  }
  press(seq: string): void {
    this.queue.push(seq);
    this.emit("readable");
  }
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");

async function frameOf(node: React.ReactElement, waitMs = 300): Promise<string> {
  const stdout = new FakeOut();
  const app = render(node, {
    stdout: stdout as never,
    stdin: new FakeIn() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await new Promise((r) => setTimeout(r, waitMs));
  app.unmount();
  return stdout.frames.join("").replace(ANSI, "");
}

let pass = 0;
let fail = 0;
function has(label: string, frame: string, needle: string): void {
  const ok = frame.includes(needle);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  (missing ${JSON.stringify(needle)})`}`);
}
function check(label: string, cond: boolean): void {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
}

applyTheme("opencode");

const LOGS = [
  { id: "r1", at: new Date(Date.now() - 120_000).toISOString(), model: "aqua:kimi-k3", ok: true, latencyMs: 2400, tokens: 1820 },
  { id: "r2", at: new Date(Date.now() - 900_000).toISOString(), model: "aqua:glm-5.2", ok: false, latencyMs: 640, tokens: null, error: "upstream 502" },
];

console.log("\n1. API keys tab");
const keysFrame = await frameOf(<AccountView apiKey={KEY} initialTab="keys" logs={LOGS} onClose={() => {}} />);
has("panel title", keysFrame, "Account");
has("tab labels", keysFrame, "API keys");
has("key name", keysFrame, "laptop");
has("second key", keysFrame, "ci");
has("request count formatted", keysFrame, "1,423");
has("relative last-used", keysFrame, "1h ago");
has("never used", keysFrame, "never");
check("full key value never printed", !keysFrame.includes(KEY));
has("key is masked", keysFrame, maskKey(KEY));

console.log("\n2. Usage tab");
const usageFrame = await frameOf(<AccountView apiKey={KEY} initialTab="usage" logs={LOGS} onClose={() => {}} />);
has("period column", usageFrame, "PERIOD");
has("today row", usageFrame, "Today");
has("year row", usageFrame, "Year");
has("compact tokens", usageFrame, "42.0K");
has("million compacted", usageFrame, "2.45M");
has("latency", usageFrame, "1.24s");
has("bar glyphs", usageFrame, "█");
has("beta budget section", usageFrame, "Beta budget");
has("budget percent", usageFrame, "61.4%");
has("what the remainder buys", usageFrame, "Kimi K3");
has("per-day section", usageFrame, "Tokens per day");
has("by-model section", usageFrame, "By model");
has("model row", usageFrame, "deepseek-v4-flash");
has("plan named", usageFrame, "Eaon Beta");

console.log("\n3. Logs tab");
const logsFrame = await frameOf(<AccountView apiKey={KEY} initialTab="logs" logs={LOGS} onClose={() => {}} />);
has("header", logsFrame, "MODEL");
has("ok row", logsFrame, "kimi-k3");
has("error row marked", logsFrame, "error");
has("token count", logsFrame, "1.82K");
has("explains it is local", logsFrame, "local record");

console.log("\n4. Failure is reported, not rendered as zeros");
globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 })) as typeof fetch;
const errFrame = await frameOf(<AccountView apiKey={KEY} initialTab="usage" logs={[]} onClose={() => {}} />);
has("surfaces the error", errFrame, "boom");
has("offers a retry", errFrame, "r to retry");
check("does not fake a zero total", !errFrame.includes("PERIOD"));

console.log("\n5. A hosted (non-account) key is rejected before any request");
const hostedFrame = await frameOf(<AccountView apiKey="not-an-eaon-key" initialTab="keys" logs={[]} onClose={() => {}} />);
has("explains which key is needed", hostedFrame, "sk-eaon-");

globalThis.fetch = realFetch;
console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
