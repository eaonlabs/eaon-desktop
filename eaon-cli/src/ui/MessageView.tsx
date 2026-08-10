// Codex transcript rhythm: › user echoes, • assistant/tools, └ result trees,
// hairline before assistant summaries. Dense margins — OpenCode spacing.

import React from "react";
import { Box, Text, useStdout } from "ink";
import { theme } from "./theme.js";
import { Markdown } from "./Markdown.js";
import { WriteFileDiff, EditFileDiff } from "./DiffView.js";
import { isKnownTool, type ToolName } from "../tools/index.js";
import type { DisplayMessage } from "./types.js";

const STREAM_TAIL_CHARS = 6000;

function StreamingText({ text }: { text: string }): React.ReactElement {
  const shown = text.length > STREAM_TAIL_CHARS ? "…" + text.slice(text.length - STREAM_TAIL_CHARS) : text;
  return (
    <Text color={theme.assistant}>
      {shown}
      <Text color={theme.muted}>▌</Text>
    </Text>
  );
}

function capLines(text: string, max: number): { shown: string; hiddenCount: number } {
  const lines = text.split("\n");
  if (lines.length <= max) return { shown: text, hiddenCount: 0 };
  return { shown: lines.slice(0, max).join("\n"), hiddenCount: lines.length - max };
}

function shorten(value: string, max = 52): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

function pathArg(args: Record<string, unknown>, key = "path"): string {
  const raw = typeof args[key] === "string" ? (args[key] as string) : "";
  return raw.length > 52 ? "…" + raw.slice(raw.length - 51) : raw;
}

/** Codex-style tool labels: Ran / Read / Wrote / Edit … */
function codexToolLabel(name: ToolName, args: Record<string, unknown>): string {
  const s = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
  switch (name) {
    case "run_shell":
      return `Ran ${shorten(s("command"), 56)}`;
    case "run_shell_background":
      return `Started ${shorten(s("command"), 52)}`;
    case "check_shell":
      return `Checked ${s("id") || "background"}`;
    case "stop_shell":
      return `Stopped ${s("id")}`;
    case "read_file":
      return `Read ${pathArg(args)}`;
    case "write_file":
      return `Wrote ${pathArg(args)}`;
    case "edit_file":
      return `Edit ${pathArg(args)}`;
    case "list_directory":
      return `Listed ${pathArg(args) || "."}`;
    case "create_folder":
      return `Created dir ${pathArg(args)}`;
    case "move_item":
      return `Moved ${pathArg(args, "from")} → ${pathArg(args, "to")}`;
    case "trash_item":
      return `Trashed ${pathArg(args)}`;
    case "grep":
      return `Searched /${shorten(s("pattern"), 36)}/`;
    case "glob":
      return `Found ${shorten(s("pattern"), 40)}`;
    case "todo_write":
      return "Updated todos";
    case "web_search":
      return `Searched web ${shorten(s("query"), 40)}`;
    case "web_fetch":
      return `Fetched ${shorten(s("url"), 48)}`;
    case "task":
      return `Delegated ${shorten(s("description"), 44)}`;
    case "exit_plan_mode":
      return "Plan ready";
    case "open_app":
      return `Opened app ${shorten(s("name"), 30)}`;
    case "quit_app":
      return `Quit app ${shorten(s("name"), 30)}`;
    case "open_url":
      return `Opened ${shorten(s("url"), 44)}`;
    case "open_path":
      return `${args.reveal === true ? "Revealed" : "Opened"} ${pathArg(args)}`;
    case "run_applescript":
      return "Ran AppleScript";
  }
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

function ToolMessage({ message }: { message: Extract<DisplayMessage, { role: "tool" }> }): React.ReactElement {
  const bulletColor = message.result?.isError ? theme.error : theme.muted;
  const label = isKnownTool(message.name) ? codexToolLabel(message.name, message.args) : message.summary || message.name;
  const diff = ToolDiff({ message });
  const detailText = !diff && message.detail ? message.detail.split("\n").slice(0, 6).join("\n") : null;

  const resultLines = (() => {
    if (message.pending) return null;
    if (!message.result) return null;
    const compact = message.result.text.trim().replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n");
    const { shown, hiddenCount } = capLines(compact, 14);
    const lines = shown.length > 0 ? shown.split("\n") : ["(no output)"];
    return { lines, hiddenCount, isError: message.result.isError };
  })();

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={bulletColor}>• </Text>
        <Text color={theme.toolName}>{label}</Text>
        {message.pending ? (
          <Text color={theme.muted} dimColor>
            {" "}
            …
          </Text>
        ) : null}
      </Text>

      {diff && (
        <Box paddingLeft={2} flexDirection="column">
          {diff}
        </Box>
      )}

      {detailText && (
        <Box paddingLeft={2}>
          <Text color={theme.muted}>
            └ {detailText.split("\n")[0]}
          </Text>
        </Box>
      )}

      {resultLines && (
        <Box flexDirection="column" paddingLeft={2}>
          {resultLines.lines.map((line, i) => (
            <Text key={i} color={resultLines.isError ? theme.error : theme.muted}>
              {i === 0 ? "└ " : "  "}
              {line}
            </Text>
          ))}
          {resultLines.hiddenCount > 0 && (
            <Text color={theme.muted} dimColor>
              {"  "}… +{resultLines.hiddenCount} more lines
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function Hairline(): React.ReactElement {
  const { stdout } = useStdout();
  const cols = Math.min(stdout?.columns ?? 72, 72);
  return (
    <Text color={theme.separator} dimColor>
      {"─".repeat(Math.max(20, cols - 2))}
    </Text>
  );
}

export function MessageView({
  message,
  separatorBefore = false,
}: {
  message: DisplayMessage;
  /** Codex hairline between tool output and the assistant summary. */
  separatorBefore?: boolean;
}): React.ReactElement {
  if (message.role === "user") {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.muted} dimColor>
          {"› "}
          {message.text}
        </Text>
      </Box>
    );
  }

  if (message.role === "system") {
    const color = message.tone === "error" ? theme.error : message.tone === "success" ? theme.success : theme.muted;
    const mark = message.tone === "error" ? "■" : message.tone === "success" ? "•" : "•";
    return (
      <Box>
        <Text color={color}>
          {mark} {message.text}
        </Text>
      </Box>
    );
  }

  if (message.role === "assistant") {
    const reasoning = message.reasoning.length > 2000 ? "…" + message.reasoning.slice(message.reasoning.length - 2000) : message.reasoning;
    const showHairline = separatorBefore && message.text.length > 0;
    return (
      <Box flexDirection="column" marginTop={showHairline ? 0 : 0}>
        {showHairline && <Hairline />}
        {reasoning.trim().length > 0 && (
          <Box flexDirection="column" marginBottom={0} paddingLeft={2}>
            <Text color={theme.reasoning} italic dimColor>
              {reasoning.trim()}
            </Text>
          </Box>
        )}
        {message.text.length > 0 ? (
          <Box>
            <Text color={theme.muted}>{"• "}</Text>
            <Box flexDirection="column" flexGrow={1}>
              {message.streaming ? <StreamingText text={message.text} /> : <Markdown text={message.text} streaming={false} />}
            </Box>
          </Box>
        ) : message.streaming ? (
          <Text color={theme.muted}>•</Text>
        ) : null}
      </Box>
    );
  }

  return <ToolMessage message={message} />;
}
