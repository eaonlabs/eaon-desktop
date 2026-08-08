// Per-session welcome — the one loud moment is the block EAON wordmark.
// Everything under it stays quiet: greeting, model/path, tips, optional
// recent sessions, then a pioneer quote. Warns loudly when launched from ~.

import React from "react";
import os from "node:os";
import { Box, Text, useStdout } from "ink";
import { theme } from "./theme.js";
import { BandedWordmark } from "./Wordmark.js";
import { EAON_WORDMARK_WIDTH } from "./logoArt.js";
import { isUnsafeProjectRoot, unsafeRootReason } from "../project/rootGuard.js";
import type { Quote } from "./quotes.js";
import type { EaonMode } from "../types.js";
import type { SessionSummary } from "../session/store.js";

function greetingName(): string {
  try {
    return os.userInfo().username || "there";
  } catch {
    return "there";
  }
}

function shortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

function relativeTime(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export interface EaonBannerProps {
  version: string;
  quote: Quote;
  mode: EaonMode;
  modelLabel: string;
  projectRoot: string;
  recentSessions: SessionSummary[];
}

const QUOTE_WIDTH = 72;

export function EaonBanner(props: EaonBannerProps): React.ReactElement {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const fitsWordmark = columns >= EAON_WORDMARK_WIDTH + 2;
  const name = greetingName();
  const pathLabel = shortenPath(props.projectRoot);
  const recent = props.recentSessions.slice(0, 3);
  const unsafeRoot = isUnsafeProjectRoot(props.projectRoot);
  void props.mode;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {fitsWordmark ? (
        <Box marginBottom={1}>
          <BandedWordmark />
        </Box>
      ) : (
        <Box marginBottom={1}>
          <Text color={theme.accent} bold>
            EAON
          </Text>
        </Box>
      )}

      <Box flexDirection="column" paddingLeft={1}>
        <Text>
          <Text color={theme.accent}>● </Text>
          <Text bold>Welcome back, {name}</Text>
          <Text color={theme.muted} dimColor>
            {" "}
            · v{props.version}
          </Text>
        </Text>
        <Text color={theme.muted} dimColor>
          {"  "}
          Agent · {props.modelLabel} · {pathLabel}
        </Text>
        <Text color={theme.muted} dimColor>
          {"  "}/help · /model · /resume · shift+tab cycles permission
        </Text>
      </Box>

      {unsafeRoot && (
        <Box flexDirection="column" marginTop={1} paddingLeft={1}>
          <Text color={theme.warning} bold>
            ⚠ Working from {unsafeRootReason(props.projectRoot)}
          </Text>
          <Text color={theme.muted} dimColor>
            {"  "}Not a project — explore tools are off. cd into a repo or use --cwd.
          </Text>
        </Box>
      )}

      {recent.length > 0 && (
        <Box flexDirection="column" marginTop={1} paddingLeft={1}>
          <Text color={theme.muted} dimColor>
            Recent · /resume to continue
          </Text>
          {recent.map((s) => (
            <Text key={s.id} color={theme.muted} dimColor>
              {"  "}
              <Text color={theme.accentSoft}>›</Text> {s.title.length > 52 ? s.title.slice(0, 49) + "…" : s.title}
              <Text dimColor>
                {"  "}
                {relativeTime(s.updatedAt)}
              </Text>
            </Text>
          ))}
        </Box>
      )}

      <Box marginTop={1} paddingLeft={3} width={Math.min(QUOTE_WIDTH, columns - 2)}>
        <Text color={theme.reasoning} italic dimColor>
          "{props.quote.text}" — {props.quote.author}
        </Text>
      </Box>
    </Box>
  );
}
