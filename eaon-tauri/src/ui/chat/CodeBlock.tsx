// A fenced code block: header bar with the language label and a copy button,
// body with the (already rehype-highlighted) code. The raw source text rides
// in as a prop so copying never has to scrape rendered spans.

import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

/** Clipboard write with the execCommand fallback older WebKitGTK builds
 *  still need. Shared by message/code copy actions across the chat UI. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

export interface CodeBlockProps {
  /** Fence language ("ts", "python", …) or null for a plain block. */
  language: string | null;
  /** The raw source text, for the copy button. */
  code: string;
  /** The highlighted <code> element rendered by react-markdown. */
  children: ReactNode;
}

export default function CodeBlock({ language, code, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    void copyText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>{language ?? "code"}</span>
        <button
          className="code-block-copy"
          onClick={onCopy}
          aria-label="Copy code"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}
