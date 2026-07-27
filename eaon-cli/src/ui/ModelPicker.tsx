// The /model overlay — an actual selectable, arrow-navigable list (matching
// Claude Code's own /model picker) with type-to-filter search: printable
// keys narrow the list live, Backspace widens it again. Scrolls a
// fixed-size window when the catalog is longer than fits on screen.

import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "./theme.js";
import { describeEntry } from "../providers/registry.js";
import type { ModelEntry } from "../types.js";

interface Props {
  models: ModelEntry[];
  currentKey: string | null;
  onSelect: (model: ModelEntry) => void;
  onCancel: () => void;
}

const VISIBLE = 10;

const PROVIDER_ORDER: Record<string, number> = { aqua: 0, custom: 1, ollama: 2 };
const PROVIDER_LABEL: Record<string, string> = { aqua: "aqua", custom: "byok", ollama: "local" };

export function ModelPicker({ models, currentKey, onSelect, onCancel }: Props): React.ReactElement {
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(() => Math.max(0, models.findIndex((m) => m.key === currentKey)));

  const filtered = useMemo(() => {
    const sorted = [...models].sort(
      (a, b) => (PROVIDER_ORDER[a.provider.kind] ?? 9) - (PROVIDER_ORDER[b.provider.kind] ?? 9) || a.display.localeCompare(b.display)
    );
    const q = filter.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((m) => m.key.toLowerCase().includes(q) || m.display.toLowerCase().includes(q) || m.requestId.toLowerCase().includes(q));
  }, [models, filter]);

  const clampedIndex = Math.min(index, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    if (key.upArrow) {
      setIndex(Math.max(0, clampedIndex - 1));
      return;
    }
    if (key.downArrow) {
      setIndex(Math.min(filtered.length - 1, clampedIndex + 1));
      return;
    }
    if (key.return) {
      if (filtered[clampedIndex]) onSelect(filtered[clampedIndex]);
      return;
    }
    if (key.escape) {
      if (filter.length > 0) {
        setFilter("");
        setIndex(0);
      } else {
        onCancel();
      }
      return;
    }
    if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1));
      setIndex(0);
      return;
    }
    if (!key.ctrl && !key.meta && !key.tab && input && input >= " ") {
      setFilter((f) => f + input);
      setIndex(0);
    }
  });

  if (models.length === 0) {
    return (
      <Box borderStyle="round" borderColor={theme.warning} paddingX={1} marginTop={1} flexDirection="column">
        <Text bold color={theme.warning}>
          No models available
        </Text>
        <Text color={theme.muted}>Try /link to set API keys (or import from Eaon Desktop), run Ollama locally, or set EAON_AQUA_API_KEY.</Text>
        <Text color={theme.muted}>Esc to close</Text>
      </Box>
    );
  }

  const start = Math.max(0, Math.min(clampedIndex - Math.floor(VISIBLE / 2), Math.max(0, filtered.length - VISIBLE)));
  const visible = filtered.slice(start, start + VISIBLE);

  return (
    <Box borderStyle="round" borderColor={theme.accent} paddingX={1} marginTop={1} flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color={theme.accent}>
          Select model
        </Text>
        <Text color={theme.muted}>type to filter · ↑/↓ · Enter · Esc</Text>
      </Box>
      {filter.length > 0 && (
        <Text color={theme.assistant}>
          filter: <Text bold>{filter}</Text>
          <Text color={theme.muted}> ({filtered.length} match{filtered.length === 1 ? "" : "es"})</Text>
        </Text>
      )}
      <Box marginTop={1} flexDirection="column">
        {filtered.length === 0 ? (
          <Text color={theme.muted}>Nothing matches "{filter}" — Backspace to widen, Esc to clear.</Text>
        ) : (
          visible.map((m, i) => {
            const realIndex = start + i;
            const isHighlighted = realIndex === clampedIndex;
            const isCurrent = m.key === currentKey;
            return (
              <Text key={m.key} color={isHighlighted ? theme.accent : theme.assistant} bold={isHighlighted}>
                {isHighlighted ? "› " : "  "}
                {isCurrent ? "✓ " : "  "}
                <Text color={theme.muted}>[{PROVIDER_LABEL[m.provider.kind] ?? m.provider.kind}] </Text>
                {describeEntry(m)}
              </Text>
            );
          })
        )}
      </Box>
      {filtered.length > VISIBLE && (
        <Text color={theme.muted}>
          {start + 1}-{Math.min(start + VISIBLE, filtered.length)} of {filtered.length}
        </Text>
      )}
    </Box>
  );
}
