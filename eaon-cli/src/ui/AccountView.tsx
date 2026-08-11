// The account panel: API keys, Usage, Logs.
//
// One component with three tabs rather than three screens, because they answer
// one question ("what is this account doing") and the user flips between them.
// Left/right or 1/2/3 switches tab; r refetches; esc closes.
//
// Data loads per tab on first visit and is then cached for the life of the panel,
// so flipping back and forth is instant and does not re-scan a month of counters
// server-side on every keypress.

import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme, SPINNER_FRAMES } from "./theme.js";
import {
  fetchAccountKeys,
  fetchAccountUsage,
  maskKey,
  type AccountKey,
  type AccountUsage,
  type UsageDay,
} from "../account/api.js";
import type { RequestLogEntry } from "../session/requestLog.js";

export type AccountTab = "keys" | "usage" | "logs";

interface Props {
  apiKey: string;
  initialTab?: AccountTab;
  /** Locally recorded requests — see session/requestLog.ts for why these are local. */
  logs: RequestLogEntry[];
  onClose: () => void;
}

const TABS: { id: AccountTab; label: string }[] = [
  { id: "keys", label: "API keys" },
  { id: "usage", label: "Usage" },
  { id: "logs", label: "Logs" },
];

const WINDOW_LABELS: { id: keyof AccountUsage["windows"]; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "7 days" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" },
  { id: "all", label: "All" },
];

function compact(n: number): string {
  const v = Number(n) || 0;
  if (Math.abs(v) < 1000) return String(Math.round(v));
  const units = [
    { d: 1e3, s: "K" },
    { d: 1e6, s: "M" },
    { d: 1e9, s: "B" },
  ];
  for (const u of units) {
    const scaled = v / u.d;
    const text = scaled.toFixed(Math.abs(scaled) < 10 ? 2 : 1);
    // Carry rather than print "1000.0K" — same rounding trap as the web dashboard.
    if (Math.abs(Number(text)) < 1000) return `${text}${u.s}`;
  }
  return String(Math.round(v));
}

function exact(n: number): string {
  return (Number(n) || 0).toLocaleString();
}

function ms(n: number): string {
  const v = Number(n) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
}

function relative(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "never";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/** Eight-step block ramp, so a bar has sub-character resolution. */
const BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const;

function bar(value: number, max: number, width: number): string {
  if (max <= 0 || value <= 0) return "";
  const cells = (value / max) * width;
  const full = Math.floor(cells);
  const rest = Math.round((cells - full) * 8);
  return "█".repeat(Math.min(full, width)) + (full < width ? BLOCKS[rest] : "");
}

function Spinner(): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 110);
    return () => clearInterval(id);
  }, []);
  return <Text color={theme.accent}>{SPINNER_FRAMES[frame]}</Text>;
}

/** A vertical sparkline of the last N days, drawn with block eighths. */
function DaySeries({ series }: { series: UsageDay[] }): React.ReactElement {
  const days = series.slice(-30);
  const max = Math.max(...days.map((d) => d.tokens), 0);

  if (max <= 0) {
    return <Text color={theme.mutedDim}>No requests in the last 30 days.</Text>;
  }

  const RAMP = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
  const spark = days
    .map((d) => (d.tokens <= 0 ? " " : RAMP[Math.min(7, Math.floor((d.tokens / max) * 8))]))
    .join("");

  return (
    <Box flexDirection="column">
      <Text color={theme.accent}>{spark}</Text>
      <Box justifyContent="space-between">
        <Text color={theme.mutedDim}>{days[0]?.day.slice(5)}</Text>
        <Text color={theme.mutedDim}>peak {compact(max)}</Text>
        <Text color={theme.mutedDim}>{days[days.length - 1]?.day.slice(5)}</Text>
      </Box>
    </Box>
  );
}

function KeysTab({ keys }: { keys: AccountKey[] }): React.ReactElement {
  if (keys.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={theme.mutedDim}>No API keys on this account.</Text>
        <Text color={theme.mutedDim}>Create one at eaon.dev — the CLI can read keys but not mint them.</Text>
      </Box>
    );
  }

  const nameWidth = Math.min(24, Math.max(8, ...keys.map((k) => (k.name ?? "unnamed").length)));

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.mutedDim}>{"NAME".padEnd(nameWidth)} </Text>
        <Text color={theme.mutedDim}>{"KEY".padEnd(20)} </Text>
        <Text color={theme.mutedDim}>{"REQUESTS".padStart(9)} </Text>
        <Text color={theme.mutedDim}>LAST USED</Text>
      </Box>
      {keys.map((k) => (
        <Box key={k.id}>
          <Text color={theme.assistant}>{(k.name ?? "unnamed").slice(0, nameWidth).padEnd(nameWidth)} </Text>
          <Text color={theme.muted}>{maskKey(k.key).padEnd(20)} </Text>
          <Text color={theme.assistant}>{exact(k.usage).padStart(9)} </Text>
          <Text color={theme.mutedDim}>{relative(k.lastUsed)}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color={theme.mutedDim}>
          {keys.length} key{keys.length === 1 ? "" : "s"} · keys are masked; the full value is only shown once at
          creation
        </Text>
      </Box>
    </Box>
  );
}

function UsageTab({ usage }: { usage: AccountUsage }): React.ReactElement {
  const w = usage.windows;
  const maxTokens = Math.max(...WINDOW_LABELS.map((x) => w[x.id]?.tokens ?? 0), 0);

  return (
    <Box flexDirection="column">
      <Text color={theme.mutedDim}>
        {"PERIOD".padEnd(8)}
        {"TOKENS".padStart(10)}
        {"REQ".padStart(8)}
        {"OK".padStart(8)}
        {"LATENCY".padStart(10)}
      </Text>
      {WINDOW_LABELS.map(({ id, label }) => {
        const t = w[id];
        if (!t) return null;
        return (
          <Box key={id}>
            <Text color={theme.assistant}>{label.padEnd(8)}</Text>
            <Text color={theme.assistant}>{compact(t.tokens).padStart(10)}</Text>
            <Text color={theme.muted}>{exact(t.requests).padStart(8)}</Text>
            <Text color={t.errors > 0 ? theme.warning : theme.muted}>
              {(t.requests ? `${t.successRate.toFixed(0)}%` : "—").padStart(8)}
            </Text>
            <Text color={theme.muted}>{(t.requests ? ms(t.avgLatencyMs) : "—").padStart(10)}</Text>
            <Text color={theme.accent}> {bar(t.tokens, maxTokens, 14)}</Text>
          </Box>
        );
      })}

      {usage.betaBudget && !usage.betaBudget.unavailable && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.heading}>
            Beta budget · this week
          </Text>
          <Box>
            <Text color={usage.betaBudget.percentUsed >= 80 ? theme.error : theme.accent}>
              {bar(usage.betaBudget.percentUsed, 100, 30).padEnd(30)}
            </Text>
            <Text color={theme.assistant}> {usage.betaBudget.percentUsed.toFixed(1)}%</Text>
          </Box>
          {usage.betaBudget.exhausted ? (
            <Text color={theme.error}>
              Spent — capped models are paused until {usage.betaBudget.resetsAt ?? "next Monday (UTC)"}.
              {usage.betaBudget.unlimitedModels?.length
                ? ` Still available: ${usage.betaBudget.unlimitedModels.join(", ")}.`
                : ""}
            </Text>
          ) : (
            <Text color={theme.mutedDim}>
              {usage.betaBudget.percentRemaining.toFixed(1)}% left, shared across all capped beta models.{" "}
              {usage.betaBudget.models
                .slice()
                .sort((a, b) => (a.allowance ?? 0) - (b.allowance ?? 0))
                .slice(0, 2)
                .map((m) => `${m.name} ${compact(m.tokensLeft ?? 0)}`)
                .join(" · ")}
            </Text>
          )}
        </Box>
      )}

      {!usage.betaBudget && "dailyTokens" in usage.quota && usage.quota.dailyTokens ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.heading}>
            Today's quota
          </Text>
          <Box>
            <Text color={usage.quota.percentUsed >= 80 ? theme.error : theme.accent}>
              {bar(usage.quota.percentUsed, 100, 30).padEnd(30)}
            </Text>
            <Text color={theme.assistant}>
              {" "}
              {exact(usage.quota.usedToday)} / {exact(usage.quota.dailyTokens)}
            </Text>
          </Box>
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        <Text bold color={theme.heading}>
          Tokens per day
        </Text>
        <DaySeries series={usage.series} />
      </Box>

      {usage.models.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.heading}>
            By model (30 days)
          </Text>
          {usage.models.slice(0, 8).map((m) => {
            const top = usage.models[0]?.tokens ?? 0;
            return (
              <Box key={m.id}>
                <Text color={theme.assistant}>{m.id.slice(0, 24).padEnd(24)}</Text>
                <Text color={theme.muted}>{compact(m.tokens).padStart(9)} </Text>
                <Text color={theme.accent}>{bar(m.tokens, top, 18)}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.mutedDim}>
          Plan: {usage.plan?.name ?? "unknown"} · counters are eventually consistent, so a request from the last
          minute may not appear yet
        </Text>
      </Box>
    </Box>
  );
}

function LogsTab({ logs }: { logs: RequestLogEntry[] }): React.ReactElement {
  if (logs.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={theme.mutedDim}>No requests from this machine yet.</Text>
        <Text color={theme.mutedDim}>Send a message and it will show up here.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={theme.mutedDim}>
        {"WHEN".padEnd(10)}
        {"MODEL".padEnd(24)}
        {"STATUS".padEnd(9)}
        {"TOKENS".padStart(8)}
        {"LATENCY".padStart(10)}
      </Text>
      {logs
        .slice()
        .reverse()
        .slice(0, 20)
        .map((entry) => (
          <Box key={entry.id}>
            <Text color={theme.mutedDim}>{relative(entry.at).padEnd(10)}</Text>
            <Text color={theme.assistant}>{entry.model.slice(0, 23).padEnd(24)}</Text>
            <Text color={entry.ok ? theme.success : theme.error}>{(entry.ok ? "ok" : "error").padEnd(9)}</Text>
            <Text color={theme.muted}>{(entry.tokens ? compact(entry.tokens) : "—").padStart(8)}</Text>
            <Text color={theme.muted}>{ms(entry.latencyMs).padStart(10)}</Text>
          </Box>
        ))}
      <Box marginTop={1}>
        <Text color={theme.mutedDim}>
          Requests made from this machine. The gateway keeps daily totals, not per-request rows, so this is the
          local record — see Usage for the account-wide view.
        </Text>
      </Box>
    </Box>
  );
}

export function AccountView({ apiKey, initialTab = "keys", logs, onClose }: Props): React.ReactElement {
  const [tab, setTab] = useState<AccountTab>(initialTab);
  const [keys, setKeys] = useState<AccountKey[] | null>(null);
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (which: AccountTab, force = false) => {
      if (which === "logs") return;
      if (!force && ((which === "keys" && keys) || (which === "usage" && usage))) return;

      setLoading(true);
      setError(null);
      const result = which === "keys" ? await fetchAccountKeys(apiKey) : await fetchAccountUsage(apiKey);
      setLoading(false);

      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (which === "keys") setKeys(result.data as AccountKey[]);
      else setUsage(result.data as AccountUsage);
    },
    [apiKey, keys, usage]
  );

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  useInput((input, key) => {
    if (key.escape || input === "q") return onClose();
    if (key.rightArrow || key.tab) {
      setTab((t) => TABS[(TABS.findIndex((x) => x.id === t) + 1) % TABS.length]!.id);
      return;
    }
    if (key.leftArrow) {
      setTab((t) => TABS[(TABS.findIndex((x) => x.id === t) - 1 + TABS.length) % TABS.length]!.id);
      return;
    }
    if (input === "1") return setTab("keys");
    if (input === "2") return setTab("usage");
    if (input === "3") return setTab("logs");
    if (input === "r") return void load(tab, true);
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={2}
      paddingY={0}
      width={82}
    >
      <Box justifyContent="space-between">
        <Text bold color={theme.assistant}>
          Account
        </Text>
        <Text color={theme.mutedDim}>esc</Text>
      </Box>

      <Box marginTop={1}>
        {TABS.map((t, i) => (
          <Text key={t.id}>
            {i > 0 ? <Text color={theme.mutedDim}>{"   "}</Text> : null}
            <Text
              backgroundColor={tab === t.id ? theme.accent : undefined}
              color={tab === t.id ? theme.accentFg : theme.muted}
              bold={tab === t.id}
            >
              {` ${i + 1} ${t.label} `}
            </Text>
          </Text>
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {loading && (
          <Text color={theme.muted}>
            <Spinner /> Loading {tab}…
          </Text>
        )}

        {!loading && error && (
          <Box flexDirection="column">
            <Text color={theme.error}>{error}</Text>
            <Text color={theme.mutedDim}>Press r to retry.</Text>
          </Box>
        )}

        {!loading && !error && tab === "keys" && keys && <KeysTab keys={keys} />}
        {!loading && !error && tab === "usage" && usage && <UsageTab usage={usage} />}
        {tab === "logs" && <LogsTab logs={logs} />}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.mutedDim}>← → switch · r refresh · esc close</Text>
      </Box>
    </Box>
  );
}
