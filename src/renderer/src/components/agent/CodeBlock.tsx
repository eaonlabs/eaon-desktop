import { useMemo, useState, type JSX } from 'react'
import { Check, ChevronDown, Copy, Eye, WrapText } from 'lucide-react'
import { CLIPBOARD_FAILED, copyText } from '../../lib/clipboard'
import { notify } from '../Notice'
import { highlight } from './highlight'
import { HtmlPreview, isPreviewable } from './HtmlPreview'

/** Past this many lines, a finished block folds to its first ones. */
const FOLD_AT = 30
const FOLDED_LINES = 18

/**
 * A fenced code block: language on the left; wrap and copy on the right.
 *
 * Coloured once it is finished (highlight.ts). While it streams it stays
 * plain, so a half-written block isn't re-tokenised on every token, and it
 * leans on the mono face and the sunken surface to stay legible. A long
 * block folds to its first lines with a Show all; wrapping is off unless
 * asked for, because a wrapped line can read as two.
 */
export function CodeBlock({
  lang,
  code,
  streaming
}: {
  lang: string
  code: string
  streaming?: boolean
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [wrapped, setWrapped] = useState(false)
  const [open, setOpen] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const lines = useMemo(() => code.split('\n').length, [code])
  const foldable = !streaming && lines > FOLD_AT
  const folded = foldable && !open
  const tokens = useMemo(() => (streaming ? null : highlight(code, lang)), [code, lang, streaming])

  return (
    <div className="code-block" data-streaming={streaming || undefined} data-folded={folded || undefined}>
      <div className="code-block__head" data-find-skip>
        <span className="code-block__lang">{lang || 'text'}</span>
        <span className="code-block__tools">
          {!streaming && isPreviewable(lang) && (
            <button className="code-block__tool code-block__tool--label" aria-label="Preview" title="See it as a page" onClick={() => setPreviewing(true)}>
              <Eye size={13} strokeWidth={1.9} />
              Preview
            </button>
          )}
          <button
            className="code-block__tool"
            aria-label={wrapped ? 'Don’t wrap lines' : 'Wrap lines'}
            aria-pressed={wrapped}
            title={wrapped ? 'Don’t wrap lines' : 'Wrap lines'}
            data-on={wrapped || undefined}
            onClick={() => setWrapped(!wrapped)}
          >
            <WrapText size={13} strokeWidth={1.9} />
          </button>
          <button
            className="code-block__copy"
            aria-label="Copy code"
            onClick={() =>
              void copyText(code).then((ok) => {
                if (!ok) return notify(CLIPBOARD_FAILED, 'error')
                setCopied(true)
                setTimeout(() => setCopied(false), 1400)
              })
            }
          >
            {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.9} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      </div>
      <pre className="code-block__body" data-wrapped={wrapped || undefined} style={folded ? { maxHeight: `calc(${FOLDED_LINES} * 1.55em + 20px)` } : undefined}>
        <code>
          {tokens
            ? tokens.map((token, index) =>
                token.kind ? (
                  <span key={index} className={`tok-${token.kind}`}>
                    {token.text}
                  </span>
                ) : (
                  token.text
                )
              )
            : code}
        </code>
      </pre>
      {previewing && <HtmlPreview html={code} onClose={() => setPreviewing(false)} />}
      {foldable && (
        <button className="code-block__fold" onClick={() => setOpen(!open)} aria-expanded={open} data-find-skip>
          <ChevronDown size={13} strokeWidth={2} data-up={open || undefined} />
          {open ? 'Show less' : `Show all ${lines} lines`}
        </button>
      )}
    </div>
  )
}
