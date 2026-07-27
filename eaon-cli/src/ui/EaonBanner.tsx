// Per-session welcome — the one loud moment is the block EAON wordmark
// (Hermes letterform, Eaon coral). Everything under it is Claude-Code quiet:
// a ✻ greeting, dim mode/model/path/tips, then a pioneer quote. No bordered
// dashboard card — that fought the transcript and made the CLI feel heavy.

import React from "react";
import os from "node:os";
import { Box, Text, useStdout } from "ink";
import { theme, MODE_LABEL } from "./theme.js";
import { BandedWordmark } from "./Wordmark.js";
import { EAON_WORDMARK_WIDTH } from "./logoArt.js";
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
  const path = shortenPath(props.projectRoot);

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
          <Text color={theme.accent}>✻ </Text>
          <Text bold>Welcome back, {name}</Text>
          <Text color={theme.muted} dimColor>
            {" "}
            · Eaon v{props.version}
          </Text>
        </Text>
        <Text color={theme.muted} dimColor>
          {"  "}
          {MODE_LABEL[props.mode]} · {props.modelLabel}
        </Text>
        <Text color={theme.muted} dimColor>
          {"  "}
          {path}
        </Text>
        <Text color={theme.muted} dimColor>
          {"  "}/help for commands · shift+tab to cycle plan · sandboxed · auto
        </Text>
      </Box>

      <Box marginTop={1} paddingLeft={3} width={Math.min(QUOTE_WIDTH, columns - 2)}>
        <Text color={theme.reasoning} italic dimColor>
          "{props.quote.text}" — {props.quote.author}
        </Text>
      </Box>
    </Box>
  );
}
