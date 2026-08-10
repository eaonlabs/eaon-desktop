// The one modal shell every picker shares: a titled panel with an `esc` hint, a
// search line, and a scrolling list of grouped rows with the selected row filled
// in the accent colour.
//
// Commands, themes, models, agents and providers all looked slightly different
// before. They are the same widget with different rows, so they are one
// component now — which is also why a keybinding column and a "current" dot are
// built in rather than bolted onto each caller.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "./theme.js";

export interface PaletteRow {
  /** Stable identifier handed back to onSelect. */
  id: string;
  label: string;
  /** Dim text after the label — a description or hint. */
  hint?: string;
  /** Right-aligned accelerator, e.g. "ctrl+x m". */
  accel?: string;
  /** Group heading this row sits under. Rows with no group come first. */
  group?: string;
  /** Marks the row as the currently-active choice (a leading dot). */
  current?: boolean;
  /** Shown as a leading ✓ — used by the provider list. */
  checked?: boolean;
}

interface Props {
  title: string;
  rows: PaletteRow[];
  /** Placeholder for the search line. */
  searchPlaceholder?: string;
  /** Rows visible at once before the list scrolls. */
  visible?: number;
  /** Row to open on. Without it a long list opens at the top, which hides the
   *  choice the user already made — the theme list is 17 rows in a 14-row
   *  window, so `opencode` was simply off-screen. */
  initialId?: string;
  /** Fires as the highlight moves, so callers can live-preview (themes do). */
  onHighlight?: (id: string) => void;
  onSelect: (id: string) => void;
  onCancel: () => void;
}

/** Case-insensitive substring match over label + hint + group. */
function matches(row: PaletteRow, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    row.label.toLowerCase().includes(q) ||
    (row.hint?.toLowerCase().includes(q) ?? false) ||
    (row.group?.toLowerCase().includes(q) ?? false)
  );
}

export function Palette({
  title,
  rows,
  searchPlaceholder = "Search",
  visible = 14,
  initialId,
  onHighlight,
  onSelect,
  onCancel,
}: Props): React.ReactElement {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(() => {
    const at = initialId ? rows.findIndex((r) => r.id === initialId) : -1;
    return at >= 0 ? at : 0;
  });

  const filtered = useMemo(() => rows.filter((r) => matches(r, query)), [rows, query]);

  // Typing narrows the list, so the old index can point past the end.
  useEffect(() => {
    setIndex((i) => (i >= filtered.length ? Math.max(0, filtered.length - 1) : i));
  }, [filtered.length]);

  const selected = filtered[index];

  // onHighlight is held in a ref, and is deliberately NOT an effect dependency.
  // Callers pass an inline arrow, so its identity changes on every render of the
  // parent — and the theme picker's version repaints the parent (it reassigns
  // the palette). Depending on it therefore looped: preview → repaint → new
  // closure → effect refires → preview, until React bailed out with "Maximum
  // update depth exceeded". The highlight moving is the only thing that should
  // fire a preview.
  const highlightRef = useRef(onHighlight);
  highlightRef.current = onHighlight;

  useEffect(() => {
    if (selected) highlightRef.current?.(selected.id);
  }, [selected?.id]);

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) {
      if (selected) onSelect(selected.id);
      return;
    }
    if (key.upArrow || (key.ctrl && input === "p")) {
      setIndex((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
      return;
    }
    if (key.downArrow || (key.ctrl && input === "n")) {
      setIndex((i) => (filtered.length ? (i + 1) % filtered.length : 0));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      return;
    }
    // Ignore control keys so ctrl+c still reaches the app's own handler.
    if (input && !key.ctrl && !key.meta) setQuery((q) => q + input);
  });

  // A window around the highlight, so a long list stays navigable.
  const start = Math.max(0, Math.min(index - Math.floor(visible / 2), Math.max(0, filtered.length - visible)));
  const window = filtered.slice(start, start + visible);

  // Widest accel decides the column, so accelerators line up.
  const accelWidth = Math.max(0, ...filtered.map((r) => r.accel?.length ?? 0));

  let lastGroup: string | undefined;

  return (
    // Ink can only fill a background on <Text>, not <Box>. Faking a filled
    // panel means padding every row to the panel width, which leaves trailing
    // whitespace artefacts whenever the terminal is resized mid-render — so the
    // frame is a border and the fill is kept for the selected row, which is the
    // part that carries the look.
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={2}
      paddingY={0}
      width={72}
    >
      <Box justifyContent="space-between">
        <Text bold color={theme.assistant}>
          {title}
        </Text>
        <Text color={theme.mutedDim}>esc</Text>
      </Box>

      <Box marginTop={1}>
        {query ? (
          <Text color={theme.assistant}>{query}</Text>
        ) : (
          <Text>
            <Text backgroundColor={theme.info} color={theme.composerBg}>
              {searchPlaceholder.slice(0, 1)}
            </Text>
            <Text color={theme.mutedDim}>{searchPlaceholder.slice(1)}</Text>
          </Text>
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {window.length === 0 && <Text color={theme.mutedDim}>No matches.</Text>}

        {window.map((row, i) => {
          const isSelected = start + i === index;
          const showGroup = row.group && row.group !== lastGroup;
          lastGroup = row.group;

          return (
            <Box key={row.id} flexDirection="column">
              {showGroup && (
                <Box marginTop={start + i === 0 ? 0 : 1}>
                  <Text bold color={theme.heading}>
                    {row.group}
                  </Text>
                </Box>
              )}
              <Box justifyContent="space-between">
                <Text
                  backgroundColor={isSelected ? theme.accent : undefined}
                  color={isSelected ? theme.accentFg : theme.assistant}
                  bold={isSelected || row.current}
                >
                  {row.checked ? "✓ " : row.current ? "● " : "  "}
                  {row.label}
                  {row.hint ? " " : ""}
                  <Text
                    color={isSelected ? theme.accentFg : theme.mutedDim}
                    backgroundColor={isSelected ? theme.accent : undefined}
                    dimColor={!isSelected}
                  >
                    {row.hint ?? ""}
                  </Text>
                </Text>
                {accelWidth > 0 && (
                  <Text
                    color={isSelected ? theme.accentFg : theme.mutedDim}
                    backgroundColor={isSelected ? theme.accent : undefined}
                  >
                    {(row.accel ?? "").padStart(accelWidth)}
                  </Text>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>

      {filtered.length > window.length && (
        <Box marginTop={1}>
          <Text color={theme.mutedDim}>
            {index + 1}/{filtered.length}
          </Text>
        </Box>
      )}
    </Box>
  );
}
