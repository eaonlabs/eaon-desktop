// First-run splash — compact Codex-adjacent setup, not a theatrical boot.
// Shown exactly once before any config file exists (see App.tsx).

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme, SPINNER_FRAMES } from "./theme.js";
import type { LinkOutcome } from "./types.js";

interface Props {
  version: string;
  platformSupportsLink: boolean;
  onLogin: () => Promise<LinkOutcome>;
  onFinish: () => void;
}

const CLOSING_COPY: Record<LinkOutcome, { text: string; color: string }> = {
  linked: { text: "• Connected — bringing your providers in.", color: theme.success },
  nothing_selected: { text: "• Nothing selected — continuing without changes.", color: theme.muted },
  nothing_found: { text: "• Continuing without linking.", color: theme.muted },
  cancelled: { text: "• Cancelled — continuing without linking.", color: theme.muted },
  timed_out: { text: "• No response — continuing. Run /link anytime to retry.", color: theme.muted },
  no_platform_support: { text: "• Continuing.", color: theme.muted },
  error: { text: "• Something went wrong — continuing. Run /link anytime to retry.", color: theme.error },
};

function ConnectingIndicator(): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(id);
  }, []);
  return (
    <Text color={theme.muted}>
      <Text color={theme.accent}>{SPINNER_FRAMES[frame]}</Text> Waiting for browser… (Esc to skip)
    </Text>
  );
}

type Stage = "prompt" | "connecting" | "closing";

export function WelcomeScreen({ version, platformSupportsLink, onLogin, onFinish }: Props): React.ReactElement {
  const [stage, setStage] = useState<Stage>("prompt");
  const [closing, setClosing] = useState<{ text: string; color: string } | null>(null);
  const finishedRef = useRef(false);

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onFinish();
  }, [onFinish]);

  useEffect(() => {
    if (stage !== "closing") return;
    const t = setTimeout(finish, 1200);
    return () => clearTimeout(t);
  }, [stage, finish]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") return;
      if (stage === "prompt") {
        setStage("connecting");
        onLogin()
          .then((outcome) => {
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

  return (
    <Box flexDirection="column" paddingTop={1} paddingBottom={1} paddingX={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border}
        paddingX={1}
        width={56}
      >
        <Text>
          <Text bold color={theme.accent}>
            ›{" "}
          </Text>
          <Text bold>Eaon</Text>
          <Text color={theme.muted} dimColor>
            {" "}
            (v{version})
          </Text>
        </Text>
        <Text> </Text>
        <Text color={theme.muted}>
          Set up API keys to get started.
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1} paddingLeft={1}>
        {stage === "prompt" && (
          <>
            <Text bold color={theme.accent}>
              Press any key to continue…
            </Text>
            <Text color={theme.muted} dimColor>
              {platformSupportsLink
                ? "Import from Eaon Desktop, or enter keys in your browser."
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
