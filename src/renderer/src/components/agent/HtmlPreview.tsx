import { useEffect, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, Monitor, Smartphone, Tablet, X } from 'lucide-react'
import { notify } from '../Notice'

const WIDTHS = { desktop: '100%', tablet: '820px', phone: '390px' } as const
type Width = keyof typeof WIDTHS

/**
 * An HTML code block drawn as the page it describes, in a sandboxed frame:
 * its markup and styles, never its scripts (the frame can't reach the app,
 * and the app's own policy keeps scripts off). Open in browser runs it whole.
 */
export function HtmlPreview({ html, onClose }: { html: string; onClose: () => void }): JSX.Element {
  const [width, setWidth] = useState<Width>('desktop')
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const hasScripts = /<script[\s>]/i.test(html)
  return createPortal(
    <div className="html-preview__scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="html-preview" role="dialog" aria-modal="true" aria-label="HTML preview">
        <div className="html-preview__bar">
          <span className="html-preview__title">Preview</span>
          {hasScripts && <span className="html-preview__note">Scripts don’t run here</span>}
          <div className="html-preview__sizes" role="radiogroup" aria-label="Width">
            {(
              [
                ['desktop', Monitor, 'Full width'],
                ['tablet', Tablet, 'Tablet width'],
                ['phone', Smartphone, 'Phone width']
              ] as const
            ).map(([key, Icon, label]) => (
              <button key={key} type="button" role="radio" aria-checked={width === key} title={label} className="html-preview__size" onClick={() => setWidth(key)}>
                <Icon size={14} strokeWidth={1.9} />
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void window.api.chatCode.openHtml(html).catch((e: unknown) => notify(e instanceof Error ? e.message : String(e), 'error'))}
          >
            <ExternalLink size={13} strokeWidth={2} />
            Open in browser
          </button>
          <button type="button" className="icon-btn" aria-label="Close preview" onClick={onClose}>
            <X size={15} strokeWidth={2} />
          </button>
        </div>
        <div className="html-preview__stage">
          <iframe className="html-preview__frame" style={{ width: WIDTHS[width] }} title="HTML preview" sandbox="" srcDoc={html} />
        </div>
      </div>
    </div>,
    document.body
  )
}

/** Fences whose code is a page to look at. */
export const isPreviewable = (lang: string): boolean => /^(html|htm|xhtml|svg)$/i.test(lang.trim().split(/\s/)[0] ?? '')
