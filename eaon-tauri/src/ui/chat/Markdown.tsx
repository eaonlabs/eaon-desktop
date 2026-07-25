// Assistant prose renderer: react-markdown + GFM + rehype-highlight, styled
// by the shared .md rules. Memoized on the content string so only the one
// streaming message re-parses per frame (the send pipeline batches tokens).
// Links open in the OS browser — the webview itself never navigates.

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Element, ElementContent } from "hast";
import CodeBlock from "./CodeBlock";

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

/** Concatenates the raw text under a hast node — the copyable source of a
 *  code block after rehype-highlight has wrapped it in token spans. */
function hastText(node: Element | ElementContent): string {
  if (node.type === "text") return node.value;
  if ("children" in node) return node.children.map(hastText).join("");
  return "";
}

/** Pulls "ts" out of a code element's ["hljs", "language-ts"] class list. */
function languageOf(code: Element | undefined): string | null {
  const className: unknown = code?.properties?.className;
  const list = Array.isArray(className)
    ? className
    : typeof className === "string"
      ? className.split(" ")
      : [];
  for (const entry of list) {
    const name = String(entry);
    if (name.startsWith("language-")) return name.slice("language-".length);
  }
  return null;
}

const components: Components = {
  // Fenced blocks arrive as <pre><code>…</code></pre>; re-house them in the
  // CodeBlock chrome (header + copy) while keeping the highlighted children.
  pre({ node, children }) {
    const codeChild = node?.children.find(
      (child): child is Element => child.type === "element" && child.tagName === "code",
    );
    return (
      <CodeBlock
        language={languageOf(codeChild)}
        code={codeChild ? hastText(codeChild).replace(/\n$/, "") : ""}
      >
        {children}
      </CodeBlock>
    );
  },
  a({ node: _node, href, children, ...rest }) {
    return (
      <a
        {...rest}
        href={href}
        title={href}
        onClick={(event) => {
          event.preventDefault();
          if (href) void openUrl(href);
        }}
      >
        {children}
      </a>
    );
  },
  img({ node: _node, src, alt }) {
    // .md img rules constrain size; lazy-load so image-heavy replies don't
    // stall the scroll.
    return <img src={src} alt={alt ?? ""} loading="lazy" />;
  },
};

interface MarkdownProps {
  content: string;
}

const Markdown = memo(function Markdown({ content }: MarkdownProps) {
  return (
    <div className="md" data-selectable>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

export default Markdown;
