import { useState, type JSX } from 'react'
import { Check, Copy } from 'lucide-react'

/**
 * A fenced code block: language on the left, copy on the right.
 *
 * Deliberately not syntax-highlighted. Highlighting means shipping a grammar
 * set (Shiki, Prism) an order of magnitude larger than this whole renderer, and
 * re-tokenising every partial line on every streamed token. The block still has
 * to be legible while half-written, so it leans on the mono face and the sunken
 * surface instead, and stays cheap.
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

  return (
    <div className="code-block" data-streaming={streaming || undefined}>
      <div className="code-block__head">
        <span className="code-block__lang">{lang || 'text'}</span>
        <button
          className="code-block__copy"
          aria-label="Copy code"
          onClick={() => {
            void navigator.clipboard.writeText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1400)
          }}
        >
          {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.9} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="code-block__body">
        <code>{code}</code>
      </pre>
    </div>
  )
}
