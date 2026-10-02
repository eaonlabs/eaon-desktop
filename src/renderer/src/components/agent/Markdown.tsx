import { memo, useMemo, useRef, type JSX, type ReactNode } from 'react'
import { CodeBlock } from './CodeBlock'
import { parseMarkdown, type Block, type ParsedMarkdown } from './markdownBlocks'

/**
 * A small Markdown renderer, written rather than installed.
 *
 * Replies were previously dropped into the DOM as one raw text node, so every
 * fence, heading and list arrived as literal punctuation — unreadable the
 * moment a model answered with code, which in coding mode is always. The whole
 * app is dependency-light on purpose, and the subset a chat reply actually uses
 * is small, so this parses that subset instead of pulling in a parser and a
 * sanitiser.
 *
 * Nothing here is ever handed to `dangerouslySetInnerHTML`: every node is a
 * real React element, so a reply containing markup renders as the text it is.
 */

// Code spans are matched first and consume their contents, so `**` inside
// backticks stays literal rather than turning into bold.
const INLINE = /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|(?<![\w*])\*([^*\n]+?)\*(?!\w)|\[([^\]]*)\]\(([^)\s]+)\)/g

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let key = 0

  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const [, , code, bold, italic, linkText, href] = match

    if (code !== undefined) {
      out.push(
        <code key={`${keyPrefix}-${key++}`} className="md__code">
          {code}
        </code>
      )
    } else if (bold !== undefined) {
      out.push(<strong key={`${keyPrefix}-${key++}`}>{renderInline(bold, `${keyPrefix}-${key}`)}</strong>)
    } else if (italic !== undefined) {
      out.push(<em key={`${keyPrefix}-${key++}`}>{renderInline(italic, `${keyPrefix}-${key}`)}</em>)
    } else if (href !== undefined) {
      // Opened in the user's browser rather than navigating this window, which
      // has no chrome to get back from.
      out.push(
        <a
          key={`${keyPrefix}-${key++}`}
          href={href}
          onClick={(event) => {
            event.preventDefault()
            void window.api.app.openExternal(href)
          }}
        >
          {linkText || href}
        </a>
      )
    }
    last = at + match[0].length
  }

  if (last < text.length) out.push(text.slice(last))
  return out
}

export const Markdown = memo(function Markdown({ text }: { text: string }): JSX.Element {
  // Streaming text only grows, so each parse picks up from the last settled
  // block of the one before — see markdownBlocks.ts. Blocks it did not touch
  // come back as the same objects, and `MarkdownBlock` skips them.
  const parsed = useRef<ParsedMarkdown | null>(null)
  const blocks = useMemo(() => {
    parsed.current = parseMarkdown(text, parsed.current)
    return parsed.current.blocks
  }, [text])

  return (
    <>
      {blocks.map((block, index) => (
        <MarkdownBlock key={`b${index}`} block={block} id={`b${index}`} />
      ))}
    </>
  )
})

/**
 * One block, memoised on the block object: during streaming every block but
 * the last few is the same object as before, so only the tail re-renders
 * instead of the whole reply on every batch of tokens.
 */
const MarkdownBlock = memo(function MarkdownBlock({ block, id }: { block: Block; id: string }): JSX.Element {
  switch (block.kind) {
    case 'code':
      return <CodeBlock lang={block.lang} code={block.code} streaming={block.streaming} />
    case 'heading': {
      const Tag = `h${Math.min(block.level + 2, 6)}` as 'h3'
      return <Tag className="md__heading">{renderInline(block.text, id)}</Tag>
    }
    case 'list':
      return block.ordered ? (
        <ol className="md__list">
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item, `${id}-${i}`)}</li>
          ))}
        </ol>
      ) : (
        <ul className="md__list">
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item, `${id}-${i}`)}</li>
          ))}
        </ul>
      )
    case 'quote':
      return <blockquote className="md__quote">{renderInline(block.lines.join('\n'), id)}</blockquote>
    case 'rule':
      return <hr className="md__rule" />
    default:
      return <p className="md__p">{renderInline(block.text, id)}</p>
  }
})
