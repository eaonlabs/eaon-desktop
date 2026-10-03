import { memo, useMemo, useRef, type JSX, type ReactNode } from 'react'
import { CodeBlock } from './CodeBlock'
import { MarkdownTable } from './MarkdownTables'
import { parseMarkdown, type Block, type ListItem, type ParsedMarkdown } from './markdownBlocks'

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
// backticks stays literal rather than turning into bold. `_` and `__` only
// count at word edges, so snake_case names stay as they are.
const INLINE = new RegExp(
  [
    '(?<tick>`+)(?<code>[\\s\\S]*?)\\k<tick>',
    '\\*\\*(?<bold>[\\s\\S]+?)\\*\\*',
    '(?<![\\w_])__(?<boldU>[^_\\s](?:[\\s\\S]*?[^_\\s])?)__(?![\\w_])',
    '~~(?<strike>[^~\\n]+?)~~',
    '(?<![\\w*])\\*(?<italic>[^*\\n]+?)\\*(?!\\w)',
    '(?<![\\w_])_(?<italicU>[^_\\s](?:[^_\\n]*?[^_\\s])?)_(?![\\w_])',
    '\\[(?<linkText>[^\\]]*)\\]\\((?<href>[^)\\s]+)\\)',
    '<(?<angle>https?:\\/\\/[^\\s>]+)>',
    // A bare address, without the punctuation a sentence puts after it.
    '(?<bare>https?:\\/\\/[^\\s<>()\\[\\]]*[^\\s<>()\\[\\].,;:!?\'"*_~])'
  ].join('|'),
  'g'
)

/** Links open in the user's browser; anything but the web and mail is shown as text. */
const OPENABLE = /^(https?:|mailto:)/i

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let key = 0

  const link = (href: string, label: ReactNode): ReactNode =>
    OPENABLE.test(href) ? (
      <a
        key={`${keyPrefix}-${key++}`}
        href={href}
        onClick={(event) => {
          // Opened in the user's browser rather than navigating this window,
          // which has no chrome to get back from.
          event.preventDefault()
          void window.api.app.openExternal(href)
        }}
      >
        {label}
      </a>
    ) : (
      <span key={`${keyPrefix}-${key++}`}>{label}</span>
    )

  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const g = match.groups ?? {}

    if (g.code !== undefined) {
      out.push(
        <code key={`${keyPrefix}-${key++}`} className="md__code">
          {g.code}
        </code>
      )
    } else if (g.bold !== undefined || g.boldU !== undefined) {
      out.push(<strong key={`${keyPrefix}-${key++}`}>{renderInline(g.bold ?? g.boldU, `${keyPrefix}-${key}`)}</strong>)
    } else if (g.strike !== undefined) {
      out.push(<del key={`${keyPrefix}-${key++}`}>{renderInline(g.strike, `${keyPrefix}-${key}`)}</del>)
    } else if (g.italic !== undefined || g.italicU !== undefined) {
      out.push(<em key={`${keyPrefix}-${key++}`}>{renderInline(g.italic ?? g.italicU, `${keyPrefix}-${key}`)}</em>)
    } else if (g.href !== undefined) {
      out.push(link(g.href, g.linkText ? renderInline(g.linkText, `${keyPrefix}-${key}`) : g.href))
    } else if (g.angle !== undefined || g.bare !== undefined) {
      const href = g.angle ?? g.bare
      out.push(link(href, href))
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
    case 'list': {
      const items = block.items.map((item, i) => <ListEntry key={i} item={item} id={`${id}-${i}`} />)
      const tasks = block.items.some((item) => item.checked !== null)
      return block.ordered ? (
        <ol className="md__list" start={block.start === 1 ? undefined : block.start}>
          {items}
        </ol>
      ) : (
        <ul className="md__list" data-tasks={tasks || undefined}>
          {items}
        </ul>
      )
    }
    case 'table':
      // A comparison or a data table, depending on what the cells hold (MarkdownTables.tsx).
      return <MarkdownTable header={block.header} rows={block.rows} align={block.align} renderCell={renderInline} id={id} />
    case 'quote':
      return <blockquote className="md__quote">{renderInline(block.lines.join('\n'), id)}</blockquote>
    case 'rule':
      return <hr className="md__rule" />
    default:
      return <p className="md__p">{renderInline(block.text, id)}</p>
  }
})

/** One list item: its own text, a task box if it is one, and whatever is nested under it. */
function ListEntry({ item, id }: { item: ListItem; id: string }): JSX.Element {
  return (
    <li className={item.checked !== null ? 'md__task' : undefined}>
      {item.checked !== null && (
        <span className="md__check" data-checked={item.checked || undefined} aria-label={item.checked ? 'Done' : 'Not done'} role="img" />
      )}
      {renderInline(item.text, id)}
      {item.children.map((child, c) => (
        <MarkdownBlock key={c} block={child} id={`${id}-c${c}`} />
      ))}
    </li>
  )
}
