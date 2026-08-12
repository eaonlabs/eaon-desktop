// Sandboxed-mode confirmation — Codex/OpenCode language: • header, └ detail,
// › cursor, Allow once / Allow always / Reject.

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "./theme.js";
import type { PermissionAnswer } from "../agent/loop.js";

interface Props {
  name: string;
  summary: string;
  detail?: string;
  onAnswer: (answer: PermissionAnswer) => void;
}

const OPTIONS: Array<{ key: string; label: string; answer: PermissionAnswer }> = [
  { key: "y", label: "Allow once", answer: "approve" },
  { key: "a", label: "Allow always for this tool", answer: "always_this_tool" },
  { key: "n", label: "Reject (esc)", answer: "deny" },
];

export function PermissionPrompt({ name, summary, detail, onAnswer }: Props): React.ReactElement {
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    const lower = input.toLowerCase();
    const direct = OPTIONS.find((o) => o.key === lower);
    if (direct) {
      onAnswer(direct.answer);
      return;
    }
    const num = parseInt(input, 10);
    if (num >= 1 && num <= OPTIONS.length) {
      onAnswer(OPTIONS[num - 1].answer);
      return;
    }
    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIndex((i) => Math.min(OPTIONS.length - 1, i + 1));
      return;
    }
    if (key.return) {
      onAnswer(OPTIONS[index].answer);
      return;
    }
    if (key.escape) {
      onAnswer("deny");
    }
  });

  const detailLines = detail ? detail.split("\n") : [];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1} marginTop={1}>
      <Text>
        <Text color={theme.warning}>• </Text>
        <Text bold>{summary}</Text>
        <Text color={theme.muted} dimColor>
          {" "}
          ({name})
        </Text>
      </Text>
      {detailLines.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {detailLines.slice(0, 16).map((line, i) => (
            <Text key={i} color={theme.muted}>
              {i === 0 ? "└ " : "  "}
              {line}
            </Text>
          ))}
          {detailLines.length > 16 && (
            <Text color={theme.muted} dimColor>
              {"  "}…truncated
            </Text>
          )}
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        {OPTIONS.map((opt, idx) => (
          <Text key={opt.key} color={idx === index ? theme.accent : theme.assistant} bold={idx === index}>
            {idx === index ? "› " : "  "}
            {idx + 1}. {opt.label}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
