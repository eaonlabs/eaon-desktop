// Plan mode's approval gate. The model has finished researching and is
// asking to start work; this shows the plan and takes the decision.
//
// Deliberately renders the plan as real Markdown (it's the one tool result
// the user actually has to READ carefully, not skim) and offers the two
// answers that matter: go, or keep planning. Approving flips the running
// turn out of plan mode so the agent continues immediately — the user
// approves once and work begins, rather than approving and then having to
// re-prompt.

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "./theme.js";
import { Markdown } from "./Markdown.js";

interface Props {
  plan: string;
  onAnswer: (approve: boolean) => void;
}

const OPTIONS = [
  { label: "Yes — start working on this", approve: true },
  { label: "No — keep planning (esc)", approve: false },
];

export function PlanReview({ plan, onAnswer }: Props): React.ReactElement {
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    const lower = input.toLowerCase();
    if (lower === "y") {
      onAnswer(true);
      return;
    }
    if (lower === "n") {
      onAnswer(false);
      return;
    }
    const num = parseInt(input, 10);
    if (num >= 1 && num <= OPTIONS.length) {
      onAnswer(OPTIONS[num - 1].approve);
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
      onAnswer(OPTIONS[index].approve);
      return;
    }
    if (key.escape) onAnswer(false);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginTop={1}>
      <Text>
        <Text color={theme.accent}>● </Text>
        <Text bold>Ready to start — here's the plan</Text>
      </Text>
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        <Markdown text={plan} streaming={false} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        {OPTIONS.map((opt, idx) => (
          <Text key={opt.label} color={idx === index ? theme.accent : theme.assistant}>
            {idx === index ? "❯ " : "  "}
            {idx + 1}. {opt.label}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
