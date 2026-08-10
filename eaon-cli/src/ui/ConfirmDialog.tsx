// A titled panel with a message and two right-aligned buttons, the confirming
// one filled in the accent colour. Used by the update prompt, and general enough
// for any other yes/no that needs to interrupt.
//
// Left/right or tab moves between the buttons; enter takes the highlighted one;
// esc is always the cancelling answer, so a stray keypress can never confirm.

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "./theme.js";

interface Props {
  title: string;
  /** Body copy. Wrapped by Ink at the panel width. */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Which button starts highlighted. */
  defaultChoice?: "confirm" | "cancel";
  /** Extra dim line under the buttons — e.g. what the update will run. */
  footnote?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Skip",
  defaultChoice = "confirm",
  footnote,
  onConfirm,
  onCancel,
}: Props): React.ReactElement {
  const [choice, setChoice] = useState<"confirm" | "cancel">(defaultChoice);

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.leftArrow || key.rightArrow || key.tab) {
      setChoice((c) => (c === "confirm" ? "cancel" : "confirm"));
      return;
    }
    if (key.return) return choice === "confirm" ? onConfirm() : onCancel();
    // Initials work too, so "y"/"n" habits do the obvious thing.
    const ch = input.toLowerCase();
    if (ch === "y") return onConfirm();
    if (ch === "n" || ch === "s") return onCancel();
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={2}
      paddingY={0}
      width={64}
    >
      <Box justifyContent="space-between">
        <Text bold color={theme.assistant}>
          {title}
        </Text>
        <Text color={theme.mutedDim}>esc</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.muted}>{message}</Text>
      </Box>

      <Box marginTop={1} justifyContent="flex-end">
        <Text
          color={choice === "cancel" ? theme.accentFg : theme.muted}
          backgroundColor={choice === "cancel" ? theme.accent : undefined}
          bold={choice === "cancel"}
        >
          {` ${cancelLabel} `}
        </Text>
        <Text> </Text>
        <Text
          color={choice === "confirm" ? theme.accentFg : theme.muted}
          backgroundColor={choice === "confirm" ? theme.accent : undefined}
          bold={choice === "confirm"}
        >
          {` ${confirmLabel} `}
        </Text>
      </Box>

      {footnote && (
        <Box marginTop={1}>
          <Text color={theme.mutedDim} dimColor>
            {footnote}
          </Text>
        </Box>
      )}
    </Box>
  );
}
