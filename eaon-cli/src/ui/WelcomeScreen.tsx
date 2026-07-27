// The first-run splash — shown exactly once, before the user has any
// config file on disk (see App.tsx). Deliberately NOT the same shape as
// the regular in-app banner (EaonBanner.tsx): that one is a dense,
// bordered information card meant to reorient a returning user fast; this
// one is a rare, once-per-install moment, so it gets to be spacious and
// theatrical instead — a floating wordmark on black, the same register as
// an old terminal boot/login screen, which is genuine territory for a
// coding CLI's audience rather than a borrowed web-dashboard look.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { theme, SPINNER_FRAMES } from "./theme.js";
import { EAON_WORDMARK_WIDTH } from "./logoArt.js";
import { BandedWordmark } from "./Wordmark.js";
import { EAON_ICON_GRID, EAON_ICON_PALETTE, EAON_ICON_SIZE } from "./iconArt.js";
import type { LinkOutcome } from "./types.js";

/** The real Eaon app icon, as terminal block art — 2 source pixel-rows per
 * terminal row via the classic half-block trick (▀'s own foreground paints
 * the cell's top half, its background paints the bottom half), so a 44x44
 * pixel grid renders as a roughly-square 44x22 block instead of a
 * vertically-squashed one. Colors are the real measured icon pixels
 * (iconArt.ts), transparent (-1) pixels render nothing so the terminal's
 * own background shows through the rounded corners instead of a black box.
 * Built once and memoized — this is static content, not something that
 * should rebuild on every WelcomeScreen re-render (stage changes, etc). */
function IconArt(): React.ReactElement {
  const rows = useMemo(() => {
    const out: React.ReactElement[] = [];
    for (let r = 0; r < EAON_ICON_SIZE / 2; r++) {
      const top = EAON_ICON_GRID[r * 2];
      const bottom = EAON_ICON_GRID[r * 2 + 1];
      const cells: React.ReactElement[] = [];
      for (let c = 0; c < EAON_ICON_SIZE; c++) {
        const topHex = top[c] === -1 ? null : EAON_ICON_PALETTE[top[c]];
        const botHex = bottom[c] === -1 ? null : EAON_ICON_PALETTE[bottom[c]];
        if (topHex === null && botHex === null) {
          cells.push(<Text key={c}> </Text>);
        } else if (topHex !== null && botHex !== null) {
          cells.push(
            <Text key={c} color={topHex} backgroundColor={botHex}>
              ▀
            </Text>
          );
        } else if (topHex !== null) {
          cells.push(
            <Text key={c} color={topHex}>
              ▀
            </Text>
          );
        } else {
          cells.push(
            <Text key={c} color={botHex as string}>
              ▄
            </Text>
          );
        }
      }
      out.push(<Text key={r}>{cells}</Text>);
    }
    return out;
  }, []);
  return <Box flexDirection="column">{rows}</Box>;
}

interface Props {
  version: string;
  /** True only on macOS — /link's discovery mechanism is UserDefaults,
   * which doesn't exist anywhere else. */
  platformSupportsLink: boolean;
  /** App.tsx's real handleLink — reused as-is so there's exactly one
   * implementation of "what /link does", not a second copy in here. */
  onLogin: () => Promise<LinkOutcome>;
  /** Called exactly once, whenever this screen's job is done — linked,
   * skipped, or nothing to link to. Reveals the normal app. */
  onFinish: () => void;
}

const CLOSING_COPY: Record<LinkOutcome, { text: string; color: string }> = {
  linked: { text: "✓ Connected — bringing your providers in.", color: theme.success },
  nothing_selected: { text: "Nothing selected — continuing without changes.", color: theme.muted },
  nothing_found: { text: "Continuing without linking.", color: theme.muted },
  cancelled: { text: "Cancelled — continuing without linking.", color: theme.muted },
  timed_out: { text: "No response — continuing. Run /link anytime to retry.", color: theme.muted },
  no_platform_support: { text: "Continuing.", color: theme.muted },
  error: { text: "Something went wrong — continuing. Run /link anytime to retry.", color: theme.error },
};

/** Slow, deliberate pulse (not a fast blink) — signals "this is waiting on
 * you" the way a terminal cursor does, without reading as decoration.
 * Local interval, isolated re-render, same pattern as ThinkingIndicator. */
function PulsingPrompt({ text }: { text: string }): React.ReactElement {
  const [dim, setDim] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setDim((d) => !d), 650);
    return () => clearInterval(id);
  }, []);
  return (
    <Text color={theme.success} dimColor={dim} bold>
      {text}
    </Text>
  );
}

function ConnectingIndicator(): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(id);
  }, []);
  return (
    <Text color={theme.muted}>
      <Text color={theme.accent}>{SPINNER_FRAMES[frame]}</Text> Waiting for you to confirm in the browser… (Esc to skip)
    </Text>
  );
}

type Stage = "prompt" | "connecting" | "closing";

export function WelcomeScreen({ version, platformSupportsLink, onLogin, onFinish }: Props): React.ReactElement {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows;
  const [stage, setStage] = useState<Stage>("prompt");
  const [closing, setClosing] = useState<{ text: string; color: string } | null>(null);
  const finishedRef = useRef(false);

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onFinish();
  }, [onFinish]);

  // Auto-advance once the closing line has had a moment to actually be read.
  useEffect(() => {
    if (stage !== "closing") return;
    const t = setTimeout(finish, 1200);
    return () => clearTimeout(t);
  }, [stage, finish]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") return; // the app-level double-Ctrl+C exit owns this
      if (stage === "prompt") {
        setStage("connecting");
        onLogin()
          .then((outcome) => {
            // The user may have already pressed Esc and moved on while this
            // was in flight — the link attempt still completes in the
            // background either way, but this screen is gone; don't touch
            // its state.
            if (finishedRef.current) return;
            setClosing(CLOSING_COPY[outcome]);
            setStage("closing");
          })
          .catch(() => {
            if (finishedRef.current) return;
            setClosing(CLOSING_COPY.error);
            setStage("closing");
          });
        return;
      }
      if (stage === "connecting" && key.escape) {
        finish();
      }
    },
    { isActive: stage !== "closing" }
  );

  const fitsFullArt = columns >= EAON_WORDMARK_WIDTH + 4;
  // The icon needs only 44 cols (narrower than the wordmark's 54), so
  // fitsFullArt already covers width; height is the real constraint here —
  // icon (22 rows) + wordmark (8) + version/prompt/padding (~10) wants
  // roughly 40 rows. Unknown height (rows undefined) defaults to showing
  // it rather than assuming too little.
  const fitsIcon = fitsFullArt && (rows === undefined || rows >= 40);

  return (
    <Box flexDirection="column" width="100%" paddingTop={2} paddingBottom={1}>
      {fitsIcon && (
        <Box flexDirection="column" alignItems="center" width="100%" marginBottom={1}>
          <IconArt />
        </Box>
      )}

      <Box flexDirection="column" alignItems="center" width="100%">
        {fitsFullArt ? (
          <BandedWordmark />
        ) : (
          <Text color={theme.accent} bold>
            EAON
          </Text>
        )}
      </Box>

      <Box flexDirection="column" alignItems="center" width="100%" marginTop={1}>
        <Text color={theme.muted}>v{version}</Text>
      </Box>

      <Box flexDirection="column" alignItems="center" width="100%" marginTop={2}>
        {stage === "prompt" && (
          <>
            <PulsingPrompt text="Press any key to set up keys…" />
            <Text color={theme.muted}>
              {platformSupportsLink
                ? "Import from Eaon Desktop, or enter API keys in your browser."
                : "Enter API keys and providers in your browser."}
            </Text>
          </>
        )}
        {stage === "connecting" && <ConnectingIndicator />}
        {stage === "closing" && closing && <Text color={closing.color}>{closing.text}</Text>}
      </Box>
    </Box>
  );
}
