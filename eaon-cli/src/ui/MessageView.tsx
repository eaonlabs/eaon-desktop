import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import { Markdown } from "./Markdown.js";
import { WriteFileDiff, EditFileDiff } from "./DiffView.js";
import { EaonBanner } from "./EaonBanner.js";
import { isKnownTool, toolInvocationLabel } from "../tools/index.js";
import type { DisplayMessage } from "./types.js";

/** Quiet placeholder while the model hasn't streamed text yet. Timing and
 * interrupt hints live under the composer (GenerationStatus) so we don't
 * show two competing busy lines. */

/** The whole reason long replies used to lag. While a message is still
 * streaming, rendering the full Markdown block tree — re-parsing the entire
 * growing string and re-laying-out every block node in Yoga on every ~40ms
 * flush — is quadratic in the reply's length. Nobody can read syntax-
 * highlighted, block-formatted output that's still scrolling anyway, so
 * while streaming we render one cheap plain-text node (tail-bounded so a
 * runaway reply can't blow up per-flush cost either); the full Markdown
 * render happens exactly once, when the finished message is committed to
 * <Static> and never re-rendered again. */
const STREAM_TAIL_CHARS = 6000;
function StreamingText({ text }: { text: string }): React.ReactElement {
  const shown = text.length > STREAM_TAIL_CHARS ? "…" + text.slice(text.length - STREAM_TAIL_CHARS) : text;
  return (
    <Text color={theme.assistant}>
      {shown}
      <Text color={theme.accent}>▌</Text>
    </Text>
  );
}

function capLines(text: string, max: number): { shown: string; hiddenCount: number } {
  const lines = text.split("\n");
  if (lines.length <= max) return { shown: text, hiddenCount: 0 };
  return { shown: lines.slice(0, max).join("\n"), hiddenCount: lines.length - max };
}

function ToolDiff({ message }: { message: Extract<DisplayMessage, { role: "tool" }> }): React.ReactElement | null {
  if (message.name === "write_file" && typeof message.args.path === "string" && typeof message.args.content === "string") {
    return <WriteFileDiff path={message.args.path} content={message.args.content} />;
  }
  if (
    message.name === "edit_file" &&
    typeof message.args.path === "string" &&
    typeof message.args.search === "string" &&
    typeof message.args.replace === "string"
  ) {
    return <EditFileDiff path={message.args.path} search={message.args.search} replace={message.args.replace} />;
  }
  return null;
}

/** One tool call, Claude-Code style: a status-colored ● bullet with a
 * compact `Tool(arg)` label, then the diff (for writes/edits) and/or the
 * result branched underneath with a `⎿` connector. */
function ToolMessage({ message }: { message: Extract<DisplayMessage, { role: "tool" }> }): React.ReactElement {
  const statusColor = message.pending ? theme.warning : message.result?.isError ? theme.error : theme.success;
  const label = isKnownTool(message.name) ? toolInvocationLabel(message.name, message.args) : message.summary || message.name;
  const diff = ToolDiff({ message });

  // A short detail line (the actual command / script) for tools where the
  // label alone doesn't show what will run — only when there's no diff.
  const detailText = !diff && message.detail ? message.detail.split("\n").slice(0, 6).join("\n") : null;

  const resultLines = (() => {
    if (message.pending) return null;
    if (!message.result) return null;
    // Collapse runs of blank lines: shell output in particular is full of
    // them, and in a ⎿-indented block they read as the tool having stalled
    // rather than as spacing.
    const compact = message.result.text.trim().replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n");
    const { shown, hiddenCount } = capLines(compact, 14);
    const lines = shown.length > 0 ? shown.split("\n") : ["(no output)"];
    return { lines, hiddenCount, isError: message.result.isError };
  })();

  return (
    <Box marginTop={1} flexDirection="column">
      <Text>
        <Text color={statusColor}>● </Text>
        <Text color={theme.toolName} bold>{label}</Text>
        {message.pending ? <Text color={theme.muted} dimColor> running</Text> : null}
      </Text>

      {diff && <Box marginTop={1} paddingLeft={2}>{diff}</Box>}

      {detailText && (
        <Box paddingLeft={2}>
          <Text color={theme.muted}>{detailText}</Text>
        </Box>
      )}

      {resultLines && (
        <Box flexDirection="column" paddingLeft={2}>
          {resultLines.lines.map((line, i) => (
            <Text key={i} color={resultLines.isError ? theme.error : theme.muted}>
              {i === 0 ? "⎿  " : "   "}
              {line}
            </Text>
          ))}
          {resultLines.hiddenCount > 0 && <Text color={theme.muted}>   … +{resultLines.hiddenCount} more lines</Text>}
        </Box>
      )}
    </Box>
  );
}

export function MessageView({ message }: { message: DisplayMessage }): React.ReactElement {
  if (message.role === "banner") {
    return (
      <Box marginBottom={1} flexDirection="column">
        <EaonBanner
          version={message.version}
          quote={message.quote}
          mode={message.mode}
          modelLabel={message.modelLabel}
          projectRoot={message.projectRoot}
          recentSessions={message.recentSessions}
        />
      </Box>
    );
  }

  if (message.role === "user") {
    // Claude-Code/Cursor: your prompt echoes dim so answers stay loud.
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.muted} dimColor>
          {"❯ "}
          {message.text}
        </Text>
      </Box>
    );
  }

  if (message.role === "system") {
    const color = message.tone === "error" ? theme.error : message.tone === "success" ? theme.success : theme.muted;
    const mark = message.tone === "error" ? "✗" : message.tone === "success" ? "✓" : "·";
    return (
      <Box marginTop={1}>
        <Text color={color}>
          {mark} {message.text}
        </Text>
      </Box>
    );
  }

  if (message.role === "assistant") {
    // Bound the reasoning view too — a reasoning-heavy model can emit
    // thousands of tokens of chain-of-thought, and it re-renders on every
    // flush just like the main text does.
    const reasoning = message.reasoning.length > 2000 ? "…" + message.reasoning.slice(message.reasoning.length - 2000) : message.reasoning;
    return (
      <Box marginTop={1} flexDirection="column">
        {reasoning.trim().length > 0 && (
          <Box flexDirection="column" marginBottom={1} paddingLeft={1} borderStyle="single" borderColor={theme.border} borderTop={false} borderRight={false} borderBottom={false}>
            <Text color={theme.reasoning} italic>
              {reasoning.trim()}
            </Text>
          </Box>
        )}
        {message.text.length > 0 ? (
          <Box>
            <Text color={theme.accent}>{"● "}</Text>
            <Box flexDirection="column" flexGrow={1}>
              {message.streaming ? <StreamingText text={message.text} /> : <Markdown text={message.text} streaming={false} />}
            </Box>
          </Box>
        ) : message.streaming ? (
          <Text color={theme.accent}>●</Text>
        ) : null}
      </Box>
    );
  }

  // tool
  return <ToolMessage message={message} />;
}
