// Block wordmark in the Hermes-Agent letterform style (solid █ pixels,
// horizontal bands, one-cell drop shadow) — but in Eaon's coral family,
// not Hermes gold. Shared by EaonBanner and WelcomeScreen.

import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { EAON_WORDMARK, isWordmarkBlock } from "./logoArt.js";
import { theme } from "./theme.js";

/** Three-band coral ramp — bright face → mid coral → deep coral. */
const BAND_COLORS: readonly string[] = [
  theme.accentSoft,
  theme.accent,
  "#D45A3C",
];

const SHADOW_COLOR = theme.accentDeep;

function bandForRow(rowIndex: number, totalRows: number): string {
  const band = Math.min(2, Math.floor((rowIndex / totalRows) * 3));
  return BAND_COLORS[band];
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
    for (let c = 0; c < art[r].length; c++) {
      if (!isWordmarkBlock(art[r][c])) continue;
      face[r][c] = true;
      if (r + 1 < rows && c + 1 < cols) shadow[r + 1][c + 1] = true;
    }
  }

  return { face, shadow, rows, cols };
}

export function BandedWordmark(): React.ReactElement {
  const { face, shadow, rows, cols } = useMemo(() => buildGrids(EAON_WORDMARK), []);
  const faceRows = EAON_WORDMARK.length;

  const lines: React.ReactElement[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: React.ReactElement[] = [];
    for (let c = 0; c < cols; c++) {
      const isFace = r < faceRows && face[r][c];
      if (isFace) {
        cells.push(
          <Text key={c} bold color={bandForRow(r, faceRows)}>
            █
          </Text>
        );
      } else if (shadow[r][c]) {
        cells.push(
          <Text key={c} bold color={SHADOW_COLOR}>
            █
          </Text>
        );
      } else {
        cells.push(<Text key={c}> </Text>);
      }
    }
    lines.push(<Text key={r}>{cells}</Text>);
  }

  return <Box flexDirection="column">{lines}</Box>;
}
