// A pragmatic terminal markdown renderer — headings, bold/italic/inline
// code, fenced code blocks (syntax-highlighted via cli-highlight), lists,
// blockquotes, rules, paragraphs. Not a full CommonMark implementation —
// tuned for what a model's replies actually contain.

import React from "react";
import { Box, Text } from "ink";
import { highlight, supportsLanguage } from "cli-highlight";
import { theme } from "./theme.js";

interface Block {
  type: "heading" | "code" | "list" | "quote" | "paragraph" | "hr" | "blank";
  level?: number;
  lang?: string;
  lines?: string[];
  text?: string;
  ordered?: boolean;
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^```\s*([a-zA-Z0-9_+-]*)\s*$/);
    if (fence) {
      const lang = fence[1] || undefined;
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "```") {
        body.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ type: "code", lang, lines: body });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", text: body.join("\n") });
      continue;
    }

    if (/^(\s*)([-*]|\d+\.)\s+/.test(line)) {
      const body: string[] = [];
      const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (!m) break;
        body.push(m[3]);
        i++;
      }
      blocks.push({ type: "list", lines: body, ordered });
      continue;
    }

    if (line.trim() === "") {
      blocks.push({ type: "blank" });
      i++;
      continue;
    }

    const body: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i])
    ) {
      body.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", text: body.join(" ") });
  }
  return blocks;
}

const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)/g;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  INLINE_RE.lastIndex = 0;
  while ((match = INLINE_RE.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(<Text key={`${keyPrefix}-${i++}`}>{text.slice(lastIndex, match.index)}</Text>);
    }
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(
        <Text key={`${keyPrefix}-${i++}`} color={theme.accent}>
          {token.slice(1, -1)}
        </Text>
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <Text key={`${keyPrefix}-${i++}`} bold>
          {token.slice(2, -2)}
        </Text>
      );
    } else {
      nodes.push(
        <Text key={`${keyPrefix}-${i++}`} italic>
          {token.slice(1, -1)}
        </Text>
      );
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(<Text key={`${keyPrefix}-${i++}`}>{text.slice(lastIndex)}</Text>);
  return nodes;
}

// Re-running cli-highlight's tokenizer over the WHOLE code block on every
// single streamed token is what made long code replies visibly lag — the
// block keeps growing, so re-highlighting it from scratch is O(n) work
// repeated O(n) times as it streams, i.e. quadratic in the code length.
// While actively streaming, skip highlighting entirely and render plain
// text (cheap, and the "syntax coloring lags a second behind the text on
// a still-streaming block" isn't something anyone can even read yet
// anyway); the final render, once streaming ends, highlights once for
// real. `useMemo` additionally guards against re-highlighting the exact
// same finished code twice.
function CodeBlock({ lang, lines, skipHighlight }: { lang?: string; lines: string[]; skipHighlight: boolean }): React.ReactElement {
  const code = lines.join("\n");
  const highlighted = React.useMemo(() => {
    if (skipHighlight) return code;
    try {
      return highlight(code, { language: lang && supportsLanguage(lang) ? lang : undefined, ignoreIllegals: true });
    } catch {
      return code;
    }
  }, [code, lang, skipHighlight]);
  const rendered = highlighted.split("\n");
  return (
    <Box
      flexDirection="column"
      paddingLeft={1}
      borderStyle="single"
      borderColor={theme.border}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      marginY={0}
    >
      {lang ? (
        <Text color={theme.muted} dimColor>
          {lang}
        </Text>
      ) : null}
      {rendered.map((line, idx) => (
        <Text key={idx}>{line.length > 0 ? line : " "}</Text>
      ))}
    </Box>
  );
}

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }): React.ReactElement {
  const blocks = React.useMemo(() => parseBlocks(text), [text]);
  return (
    <Box flexDirection="column">
      {blocks.map((block, idx) => {
        const key = `b${idx}`;
        switch (block.type) {
          case "blank":
            return <Box key={key} height={1} />;
          case "heading":
            return (
              <Box key={key}>
                <Text bold color={block.level === 1 ? theme.accent : theme.assistant}>
                  {block.text}
                </Text>
              </Box>
            );
          case "hr":
            return (
              <Text key={key} color={theme.muted}>
                {"─".repeat(40)}
              </Text>
            );
          case "quote":
            return (
              <Box key={key} paddingLeft={1} borderStyle="single" borderColor={theme.muted} borderTop={false} borderRight={false} borderBottom={false}>
                <Text color={theme.muted} italic>
                  {block.text}
                </Text>
              </Box>
            );
          case "code":
            return <CodeBlock key={key} lang={block.lang} lines={block.lines ?? []} skipHighlight={streaming} />;
          case "list":
            return (
              <Box key={key} flexDirection="column">
                {(block.lines ?? []).map((item, li) => (
                  <Box key={`${key}-${li}`}>
                    <Text color={theme.muted}>{block.ordered ? `${li + 1}.` : "•"} </Text>
                    <Text>{renderInline(item, `${key}-${li}`)}</Text>
                  </Box>
                ))}
              </Box>
            );
          case "paragraph":
            return <Text key={key}>{renderInline(block.text ?? "", key)}</Text>;
          default:
            return null;
        }
      })}
    </Box>
  );
}
