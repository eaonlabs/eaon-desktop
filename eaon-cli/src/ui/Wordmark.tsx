// The EAON wordmark with a Hermes-Agent-style banded gradient: each row of
// the block art is a solid color step in a light→dark ramp, so the mark
// reads as horizontally banded metal rather than one flat color. Per the
// user's direction the ramp is deliberately NOT the coral accent — it's a
// glacier cyan→blue family (already Eaon-adjacent: the user/tool colors
// live in this range), which keeps the coral reserved for interactive
// accents while the wordmark gets its own identity.
//
// One shared component for both places the wordmark appears (the every-
// session EaonBanner and the one-time WelcomeScreen) so the treatment can
// never drift between them. Callers own the width check (EAON_WORDMARK_WIDTH)
// and the plain-text fallback for narrow terminals.

import React from "react";
import { Box, Text } from "ink";
import { EAON_WORDMARK } from "./logoArt.js";

/** One color per wordmark row (the art is 8 rows) — light ice at the top
 * to deep steel blue at the bottom. Solid per-row steps on purpose: the
 * banding IS the style, smooth dithering would just look like antialiasing. */
export const WORDMARK_GRADIENT: readonly string[] = [
  "#C6F2FF",
  "#A9E9FF",
  "#8CDFFF",
  "#6FD3FB",
  "#55C2F2",
  "#3FADE4",
  "#2F97D3",
  "#2680BE",
];

export function BandedWordmark(): React.ReactElement {
  return (
    <Box flexDirection="column">
      {EAON_WORDMARK.map((row, i) => (
        <Text key={i} bold color={WORDMARK_GRADIENT[Math.min(i, WORDMARK_GRADIENT.length - 1)]}>
          {row}
        </Text>
      ))}
    </Box>
  );
}
