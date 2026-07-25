// The in-session welcome banner — the compact Claude-Code-style card: a
// small rounded box with a ✻ greeting plus dim model/path lines, then tips
// and recent sessions as quiet plain lines below it. Deliberately NOT the
// big block-art moment — that lives on the one-time WelcomeScreen
// (logoArt/iconArt); this banner appears at the top of every session, so
// it has to be glanceable and cheap, not theatrical. The launch quote —
// an Eaon signature worth keeping — becomes a single dim italic line
// under the box.

import React from "react";
import os from "node:os";
import { Box, Text, useStdout } from "ink";
import { theme, MODE_LABEL } from "./theme.js";
import { BandedWordmark } from "./Wordmark.js";
import { EAON_WORDMARK_WIDTH } from "./logoArt.js";
import type { Quote } from "./quotes.js";
import type { EaonMode } from "../types.js";
import type { SessionSummary } from "../session/store.js";

/** The real OS login name — not fabricated, and not worth the complexity
 * of shelling out per-platform for a GECOS/display name (`os.userInfo()`
 * exposes only the login handle on every platform, no full-name field). */
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

export function EaonBanner(props: EaonBannerProps): React.ReactElement {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const fitsWordmark = columns >= EAON_WORDMARK_WIDTH + 2;

  // Everything under the wordmark is deliberately weightless: dim, plain,
  // indented lines. An earlier version boxed the welcome info, listed tips
  // AND listed recent sessions — roughly 25 lines of chrome before the
  // user could type, which read as clutter rather than polish. The
  // wordmark is the one loud thing; the rest just answers "what model,
  // where am I, how do I get help" and gets out of the way.
  return (
    <Box flexDirection="column">
      {fitsWordmark && (
        <Box marginBottom={1}>
          <BandedWordmark />
        </Box>
      )}

      <Box flexDirection="column" paddingLeft={1}>
        <Text>
          <Text color={theme.accent}>✻ </Text>
          <Text bold>Welcome back, {greetingName()}</Text>
          <Text color={theme.muted} dimColor> · Eaon v{props.version}</Text>
        </Text>
        <Text color={theme.muted} dimColor>
          {"  "}{MODE_LABEL[props.mode]} · {props.modelLabel}
        </Text>
        <Text color={theme.muted} dimColor>
          {"  "}{shortenPath(props.projectRoot)}
        </Text>
        <Text color={theme.muted} dimColor>
          {"  "}/help for commands · shift+tab to switch between plan, sandboxed and auto
        </Text>
      </Box>
    </Box>
  );
}
