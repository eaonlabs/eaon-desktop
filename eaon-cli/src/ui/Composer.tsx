// Codex-style composer: dark pad, bold › glyph, no round border.
// Affordance extras stay: `/` commands, `@` files, `!` shell, `#` memory.
// History is Up/Down; backslash-then-Enter inserts a newline.

import React, { useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { theme } from "./theme.js";
import { matchingCommands } from "../commands/index.js";

interface ComposerProps {
  isActive: boolean;
  history: string[];
  onSubmit: (text: string) => void;
  onTogglePermission: () => void;
  onCancel: () => void;
  queryFiles: (query: string) => string[];
  mode: "chat" | "agent" | "claw";
  /** When true, placeholder reads like Cursor's follow-up prompt. */
  hasConversation?: boolean;
  /** Permission label ("Build" / "Plan" / "Ask") shown inside the bar. */
  modeLabel?: string;
  modeColor?: string;
  /** Model name, and the provider it routes through, shown beside the mode. */
  modelLabel?: string;
  providerLabel?: string | null;
}

/** How many suggestion rows show at once. The list scrolls a window of this
 * size, so a long list (all 25 commands on a bare "/") stays browsable
 * without the dropdown swallowing the screen. */
const SUGGESTION_WINDOW = 8;

interface Suggestion {
  label: string;
  hint?: string;
  /** Replaces the active token when chosen. */
  insert: string;
  /** Set for command suggestions — lets Enter run the highlighted command. */
  commandName?: string;
}

/** The whitespace-delimited token the cursor currently sits at the end of —
 * used to detect an in-progress `@mention`. */
function mentionQueryBeforeCursor(buffer: string, cursor: number): { query: string; start: number } | null {
  const upto = buffer.slice(0, cursor);
  const m = upto.match(/(^|\s)@([^\s@]*)$/);
  if (!m) return null;
  const query = m[2];
  return { query, start: cursor - query.length - 1 };
}

export function Composer({
  isActive,
  history,
  onSubmit,
  onTogglePermission,
  onCancel,
  queryFiles,
  mode,
  hasConversation = false,
  modeLabel,
  modeColor,
  modelLabel,
  providerLabel,
}: ComposerProps): React.ReactElement {
  const { stdout } = useStdout();
  // Explicit column width — percentage width + borderStyle under Ink
  // <Static> is a common cause of ghosted/duplicated composer frames when
  // the scrollback jumps (rapid error lines). Yoga stays deterministic here.
  const columns = stdout?.columns ?? 80;
  const boxWidth = Math.max(40, columns - 2);

  const [buffer, setBuffer] = useState("");
  const [cursor, setCursor] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  /** The buffer value Esc was pressed at. While the buffer still equals
   * this, the dropdown stays closed — the escape hatch for "no, send what
   * I literally typed", which matters now that Enter runs the highlighted
   * item. Typing anything else re-opens it naturally. */
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  // A bare "/" opens the full command list — the way you discover what
  // exists without already knowing a prefix to type. (This used to require
  // length > 1, so "/" alone showed nothing.) matchingCommands("") matches
  // every command, since every name startsWith("").
  const showCommandSuggestions = buffer.startsWith("/") && !buffer.includes(" ");
  const mention = mentionQueryBeforeCursor(buffer, cursor);

  let suggestions: Suggestion[] = [];
  let suggestionKind: "command" | "file" | null = null;
  if (dismissedFor === buffer) {
    // explicitly dismissed for this exact text
  } else if (showCommandSuggestions) {
    suggestionKind = "command";
    // Deliberately NOT truncated here — the renderer scrolls a window over
    // the full list, so arrowing past the bottom reaches every command
    // rather than stopping at whatever the first few happened to be.
    suggestions = matchingCommands(buffer.slice(1)).map((c) => ({
      label: `/${c.name}`,
      hint: c.description,
      insert: `/${c.name} `,
      commandName: c.name,
    }));
  } else if (mention) {
    const files = queryFiles(mention.query);
    if (files.length > 0) {
      suggestionKind = "file";
      suggestions = files.map((f) => ({ label: f, insert: `@${f} ` }));
    }
  }

  /** THE one index every code path uses — render, Tab and Enter alike.
   * Reading raw `suggestionIndex` in the renderer while clamping it in the
   * handlers is what let the highlight and the acted-on item disagree
   * (type to narrow the list and the stale index highlighted nothing, yet
   * Tab still applied the last row). Derive once, use everywhere. */
  const activeIndex = suggestions.length === 0 ? -1 : Math.min(Math.max(suggestionIndex, 0), suggestions.length - 1);
  const activeSuggestion = activeIndex === -1 ? null : suggestions[activeIndex];

  // Scroll a fixed window over the full list (same approach as ModelPicker)
  // so all 25 commands are reachable by arrowing, while the dropdown stays a
  // sane size under the input.
  const windowStart = Math.max(
    0,
    Math.min(activeIndex - Math.floor(SUGGESTION_WINDOW / 2), Math.max(0, suggestions.length - SUGGESTION_WINDOW))
  );
  const visibleSuggestions = suggestions.slice(windowStart, windowStart + SUGGESTION_WINDOW);

  /** Puts a suggestion into the buffer. For a file mention that means
   * splicing the path in place (you're mid-sentence); for a command it
   * means replacing the whole line. Returns the resulting text so Enter
   * can submit exactly what it just inserted rather than the stale state. */
  const applySuggestion = (s: Suggestion): string => {
    if (suggestionKind === "file" && mention) {
      const next = buffer.slice(0, mention.start) + s.insert + buffer.slice(cursor);
      setBuffer(next);
      setCursor(mention.start + s.insert.length);
      setSuggestionIndex(0);
      return next;
    }
    setBuffer(s.insert);
    setCursor(s.insert.length);
    setSuggestionIndex(0);
    return s.insert;
  };

  useInput(
    (input, key) => {
      if (key.shift && key.tab) {
        onTogglePermission();
        return;
      }
      if (key.escape) {
        if (suggestions.length > 0) {
          // Genuinely close the dropdown (it used to only reset the index,
          // so it stayed open) — this is the way to submit literal text
          // instead of the highlighted command.
          setDismissedFor(buffer);
          setSuggestionIndex(0);
          return;
        }
        onCancel();
        return;
      }

      if (suggestions.length > 0 && activeSuggestion) {
        if (key.downArrow) {
          setSuggestionIndex(Math.min(activeIndex + 1, suggestions.length - 1));
          return;
        }
        if (key.upArrow) {
          setSuggestionIndex(Math.max(activeIndex - 1, 0));
          return;
        }
        if (key.tab) {
          applySuggestion(activeSuggestion);
          return;
        }
        if (key.return) {
          // Enter acts on what's HIGHLIGHTED, not on the raw typed text.
          // Previously it submitted the buffer verbatim, so arrowing to
          // /models and pressing Enter ran whatever you'd typed (/mode), and
          // arrowing to /exit from a partial "/ex" sent "/ex" to the model
          // as a chat message.
          const inserted = applySuggestion(activeSuggestion);
          if (suggestionKind === "command") {
            // Commands only autocomplete before any argument is typed (the
            // dropdown hides once the line contains a space), so there's
            // nothing to preserve — running it is what Enter means here.
            onSubmit(inserted.trim());
            setBuffer("");
            setCursor(0);
            setHistoryIndex(null);
          }
          // A file mention is part of a longer sentence, so Enter inserts
          // the path and leaves you typing rather than sending immediately.
          return;
        }
      }

      if (key.return) {
        if (buffer.endsWith("\\")) {
          const next = buffer.slice(0, -1) + "\n";
          setBuffer(next);
          setCursor(next.length);
          return;
        }
        if (buffer.trim().length === 0) return;
        onSubmit(buffer);
        setBuffer("");
        setCursor(0);
        setHistoryIndex(null);
        setSuggestionIndex(0);
        setDismissedFor(null);
        return;
      }

      if (key.upArrow) {
        if (history.length === 0) return;
        const nextIndex = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(nextIndex);
        setBuffer(history[nextIndex] ?? "");
        setCursor((history[nextIndex] ?? "").length);
        return;
      }
      if (key.downArrow) {
        if (historyIndex === null) return;
        const nextIndex = historyIndex + 1;
        if (nextIndex >= history.length) {
          setHistoryIndex(null);
          setBuffer("");
          setCursor(0);
        } else {
          setHistoryIndex(nextIndex);
          setBuffer(history[nextIndex] ?? "");
          setCursor((history[nextIndex] ?? "").length);
        }
        return;
      }
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(buffer.length, c + 1));
        return;
      }
      if (key.ctrl && input === "u") {
        // Readline semantics: kill to line start, not the whole buffer.
        setBuffer((b) => b.slice(cursor));
        setCursor(0);
        return;
      }
      if (key.ctrl && input === "k") {
        setBuffer((b) => b.slice(0, cursor));
        return;
      }
      if (key.ctrl && input === "w") {
        // Delete the word before the cursor (skip trailing spaces first).
        const before = buffer.slice(0, cursor);
        const trimmed = before.replace(/\s+$/, "");
        const start = Math.max(0, trimmed.lastIndexOf(" ") + 1, trimmed.lastIndexOf("/") + 1);
        setBuffer(buffer.slice(0, start) + buffer.slice(cursor));
        setCursor(start);
        return;
      }
      if (key.ctrl && input === "a") {
        setCursor(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setCursor(buffer.length);
        return;
      }
      // Alt/Option + B / F — word-wise cursor movement (readline standard).
      if (key.meta && (input === "b" || input === "f")) {
        if (input === "b") {
          const before = buffer.slice(0, cursor).replace(/\s+$/, "");
          setCursor(Math.max(0, before.lastIndexOf(" ") + 1));
        } else {
          const rest = buffer.slice(cursor);
          const advance = rest.replace(/^\s+/, "").search(/\s/);
          setCursor(advance === -1 ? buffer.length : cursor + (rest.length - rest.replace(/^\s+/, "").length) + advance);
        }
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        setBuffer((b) => b.slice(0, cursor - 1) + b.slice(cursor));
        setCursor((c) => c - 1);
        return;
      }
      if (!key.ctrl && !key.meta && input) {
        setBuffer((b) => b.slice(0, cursor) + input + b.slice(cursor));
        setCursor((c) => c + input.length);
      }
    },
    { isActive }
  );

  const before = buffer.slice(0, cursor);
  const atCursor = cursor < buffer.length ? buffer[cursor] : " ";
  const after = buffer.slice(cursor + 1);
  const isEmpty = buffer.length === 0;

  // Glyph: `!` shell, `#` memory, otherwise Cursor-style →. Prefix modes
  // tint the glyph; permission/model live in the status rows under the bar.
  const bash = buffer.startsWith("!");
  const memory = buffer.startsWith("#");
  const glyph = bash ? "!" : memory ? "#" : "→";
  const glyphColor = bash ? theme.warning : memory ? theme.accent : theme.assistant;
  // The reference shows the prompt plus an example of what to ask, which does
  // more to teach the tool than a bare "Ask anything".
  const placeholder = hasConversation
    ? "Add a follow-up"
    : 'Ask anything... "Fix a TODO in the codebase"';
  const bg = theme.composerBg;
  const padRow = " ".repeat(boxWidth);
  const innerWidth = Math.max(10, boxWidth - 4); // paddingX={2} each side

  const contentLen =
    2 /* glyph+space */ +
    (isEmpty ? 1 + placeholder.length : Math.min(buffer.length, innerWidth) + (cursor >= buffer.length ? 1 : 0));
  const trailPad = Math.max(0, innerWidth - contentLen);

  return (
    <Box flexDirection="column" width={boxWidth}>
      {/* Filled bar with an accent rule down the left edge. Each row draws its
          own rule so the edge stays unbroken when Ink repaints one line. */}
      <Box>
        <Text color={theme.accent}>▌</Text>
        <Text backgroundColor={bg}>{padRow}</Text>
      </Box>
      <Box width={boxWidth}>
        <Text color={theme.accent}>▌</Text>
        <Text backgroundColor={bg}>{" "}</Text>
        <Text backgroundColor={bg} color={glyphColor} bold>
          {glyph}{" "}
        </Text>
        {isEmpty ? (
          <>
            <Text backgroundColor={bg} inverse={isActive} color={theme.muted}>
              {" "}
            </Text>
            <Text backgroundColor={bg} color={theme.muted} dimColor>
              {placeholder}
            </Text>
          </>
        ) : (
          <>
            <Text backgroundColor={bg}>{before}</Text>
            <Text backgroundColor={bg} inverse={isActive} color={isActive ? undefined : theme.muted}>
              {atCursor}
            </Text>
            <Text backgroundColor={bg}>{after}</Text>
          </>
        )}
        {trailPad > 0 && <Text backgroundColor={bg}>{" ".repeat(trailPad)}</Text>}
        <Text backgroundColor={bg}>{"  "}</Text>
      </Box>
      <Box>
        <Text color={theme.accent}>▌</Text>
        <Text backgroundColor={bg}>{padRow}</Text>
      </Box>
      {/* mode · model provider — inside the bar, as the reference has it. */}
      <Box width={boxWidth}>
        <Text color={theme.accent}>▌</Text>
        <Text backgroundColor={bg}>{" "}</Text>
        <Text backgroundColor={bg} color={modeColor ?? theme.info} bold>
          {modeLabel ?? "Build"}
        </Text>
        <Text backgroundColor={bg} color={theme.mutedDim}>
          {" · "}
        </Text>
        <Text backgroundColor={bg} color={theme.assistant}>
          {modelLabel ?? ""}
        </Text>
        {providerLabel ? (
          <Text backgroundColor={bg} color={theme.mutedDim}>
            {" "}
            {providerLabel}
          </Text>
        ) : null}
        <Text backgroundColor={bg}>
          {" ".repeat(
            Math.max(
              0,
              boxWidth -
                2 -
                (modeLabel ?? "Build").length -
                3 -
                (modelLabel ?? "").length -
                (providerLabel ? providerLabel.length + 1 : 0)
            )
          )}
        </Text>
      </Box>
      <Box>
        <Text color={theme.accent}>▌</Text>
        <Text backgroundColor={bg}>{padRow}</Text>
      </Box>

      {bash && isActive && (
        <Text color={theme.muted} dimColor>
          {"  "}! runs a shell command and adds the output to the conversation
        </Text>
      )}
      {memory && isActive && (
        <Text color={theme.muted} dimColor>
          {"  "}# saves the rest of this line to EAON.md
        </Text>
      )}

      {suggestions.length > 0 && (
        <Box flexDirection="column" marginLeft={1} marginTop={0}>
          {visibleSuggestions.map((s, i) => {
            const idx = windowStart + i;
            const active = idx === activeIndex;
            return (
              <Text key={s.label} color={active ? theme.accent : theme.muted} bold={active}>
                {active ? "→ " : "  "}
                {suggestionKind === "file" ? "@" : ""}
                {s.label}
                {s.hint ? (
                  <Text color={theme.muted} dimColor bold={false}>
                    {"  "}
                    {s.hint}
                  </Text>
                ) : null}
              </Text>
            );
          })}
          {suggestions.length > SUGGESTION_WINDOW && (
            <Text color={theme.muted} dimColor>
              {"  "}
              {windowStart + 1}-{Math.min(windowStart + SUGGESTION_WINDOW, suggestions.length)} of{" "}
              {suggestions.length} · ↑↓
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
