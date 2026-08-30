import { memo, useMemo, type JSX, type ReactNode } from 'react'
import { CodeBlock } from './CodeBlock'

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

type Block =
  | { kind: 'code'; lang: string; code: string; streaming: boolean }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'rule' }
  | { kind: 'para'; text: string }

const FENCE = /^\s*```(\S*)\s*$/
const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/

function parse(source: string): Block[] {
  const lines = source.split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []

  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'para', text: paragraph.join('\n') })
    paragraph = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const code: string[] = []
      let closed = false
      for (i++; i < lines.length; i++) {
        if (FENCE.test(lines[i])) {
          closed = true
          break
        }
        code.push(lines[i])
      }
      // An unclosed fence is the normal state mid-stream, not a malformed
      // reply — render it as code already, so the block does not pop into
      // existence only once the closing fence arrives.
      blocks.push({ kind: 'code', lang: fence[1] ?? '', code: code.join('\n'), streaming: !closed })
      continue
    }

    if (line.trim() === '') {
      flush()
      continue
    }

    if (RULE.test(line)) {
      flush()
      blocks.push({ kind: 'rule' })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote) {
      flush()
      const quoted = [quote[1]]
      while (i + 1 < lines.length) {
        const next = QUOTE.exec(lines[i + 1])
        if (!next) break
        quoted.push(next[1])
        i++
      }
      blocks.push({ kind: 'quote', lines: quoted })
      continue
    }

    const bullet = BULLET.exec(line)
    const numbered = NUMBERED.exec(line)
    if (bullet || numbered) {
      flush()
      const ordered = Boolean(numbered)
      const items = [(bullet ?? numbered)![1]]
      while (i + 1 < lines.length) {
        const nextItem = ordered ? NUMBERED.exec(lines[i + 1]) : BULLET.exec(lines[i + 1])
        if (!nextItem) break
        items.push(nextItem[1])
        i++
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    paragraph.push(line)
  }

  flush()
  return blocks
}

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
  // Re-parsed on every streamed token otherwise, which is what makes a long
  // reply quadratic to render.
  const blocks = useMemo(() => parse(text), [text])

  return (
    <>
      {blocks.map((block, index) => {
        const key = `b${index}`
        switch (block.kind) {
          case 'code':
            return <CodeBlock key={key} lang={block.lang} code={block.code} streaming={block.streaming} />
          case 'heading': {
            const Tag = `h${Math.min(block.level + 2, 6)}` as 'h3'
            return (
              <Tag key={key} className="md__heading">
                {renderInline(block.text, key)}
              </Tag>
            )
          }
          case 'list':
            return block.ordered ? (
              <ol key={key} className="md__list">
                {block.items.map((item, i) => (
                  <li key={i}>{renderInline(item, `${key}-${i}`)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key} className="md__list">
                {block.items.map((item, i) => (
                  <li key={i}>{renderInline(item, `${key}-${i}`)}</li>
                ))}
              </ul>
            )
          case 'quote':
            return (
              <blockquote key={key} className="md__quote">
                {renderInline(block.lines.join('\n'), key)}
              </blockquote>
            )
          case 'rule':
            return <hr key={key} className="md__rule" />
          default:
            return (
              <p key={key} className="md__p">
                {renderInline(block.text, key)}
              </p>
            )
        }
      })}
    </>
  )
})
