// The idle splash: a large two-tone block wordmark, centred.
//
// Two-tone rather than the previous coral gradient because the gradient bands
// were captured at module load (`const BAND_COLORS = [theme.accentSoft, …]`), so
// they froze whichever scheme happened to be active when the module first
// imported and never followed a theme switch. Everything here reads `theme`
// inside render for that reason.

import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { EAON_WORDMARK, isWordmarkBlock } from "./logoArt.js";
import { theme } from "./theme.js";

/** Column the tone changes at — splits EAON into "EA" dim and "ON" bright. */
const SPLIT_COLUMN = 19;

interface Props {
  /** Terminal width, so the mark can be centred and dropped when too narrow. */
  width: number;
}

type Grid = boolean[][];

function buildGrids(art: readonly string[]): { face: Grid; shadow: Grid; rows: number; cols: number } {
  const faceRows = art.length;
  const faceCols = Math.max(...art.map((r) => r.length));
  const rows = faceRows + 1;
  const cols = faceCols + 1;

  const face: Grid = Array.from({ length: faceRows }, () => Array(faceCols).fill(false));
  const shadow: Grid = Array.from({ length: rows }, () => Array(cols).fill(false));

  for (let r = 0; r < faceRows; r++) {
    for (let c = 0; c < art[r]!.length; c++) {
      if (!isWordmarkBlock(art[r]![c]!)) continue;
      face[r]![c] = true;
      if (r + 1 < rows && c + 1 < cols) shadow[r + 1]![c + 1] = true;
    }
  }

  return { face, shadow, rows, cols };
}

export function Splash({ width }: Props): React.ReactElement | null {
  const { face, shadow, rows, cols } = useMemo(() => buildGrids(EAON_WORDMARK), []);
  const faceRows = EAON_WORDMARK.length;

  // Below this the mark wraps into unreadable fragments; a plain title is better.
  if (width < cols + 4) {
    return (
      <Box justifyContent="center">
        <Text bold color={theme.wordmarkBright}>
          EAON
        </Text>
      </Box>
    );
  }

  const lines: React.ReactElement[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: React.ReactElement[] = [];
    for (let c = 0; c < cols; c++) {
      const isFace = r < faceRows && face[r]![c];
      if (isFace) {
        cells.push(
          <Text key={c} bold color={c < SPLIT_COLUMN ? theme.wordmarkDim : theme.wordmarkBright}>
            █
          </Text>
        );
      } else if (shadow[r]![c]) {
        // One-cell extrusion, kept far dimmer than either face tone so it reads
        // as depth rather than as a third colour.
        cells.push(
          <Text key={c} color={theme.composerBg}>
            █
          </Text>
        );
      } else {
        cells.push(<Text key={c}> </Text>);
      }
    }
    lines.push(<Text key={r}>{cells}</Text>);
  }

  return (
    <Box flexDirection="column" alignItems="center">
      {lines}
    </Box>
  );
}
