// The input line. Beyond plain typing it carries Claude-Code-style
// affordances: `/` slash-command autocomplete, `@` file-mention
// autocomplete (fed by the project file index), and `!` (run a shell
// command) / `#` (save a note to EAON.md) prefix modes. History is Up/Down;
// backslash-then-Enter inserts a newline (reliable across terminals, unlike
// trying to distinguish Shift+Enter which many emulators don't report).

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

export function Composer({ isActive, history, onSubmit, onTogglePermission, onCancel, queryFiles, mode }: ComposerProps): React.ReactElement {
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

  // Prompt glyph: `!` shell, `#` memory note, otherwise coral ❯. Border only
  // colors when a prefix mode is active — permission state lives in the
  // footer, not here.
  const bash = buffer.startsWith("!");
  const memory = buffer.startsWith("#");
  const glyph = bash ? "!" : memory ? "#" : "❯";
  const glyphColor = bash ? theme.warning : memory ? theme.accent : theme.accent;
  const borderColor = bash
    ? theme.warning
    : memory
      ? theme.accent
      : isActive
        ? theme.composerBorder
        : theme.border;

  const placeholder = "What should I build?";
  void mode;

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={borderColor} paddingX={1} width={boxWidth}>
        <Text color={glyphColor} bold>
          {glyph}{" "}
        </Text>
        {isEmpty ? (
          <>
            {/* Inverse block as the caret — don't also paint a blank space
                before the placeholder or the empty line looks doubled. */}
            <Text inverse={isActive} color={theme.muted}>
              {" "}
            </Text>
            <Text color={theme.muted} dimColor>
              {placeholder}
            </Text>
          </>
        ) : (
          <>
            <Text>{before}</Text>
            <Text inverse={isActive} color={isActive ? undefined : theme.muted}>
              {atCursor}
            </Text>
            <Text>{after}</Text>
          </>
        )}
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
                {active ? "❯ " : "  "}
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
