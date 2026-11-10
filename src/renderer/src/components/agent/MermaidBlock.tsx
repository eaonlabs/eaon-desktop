import { useEffect, useState, type JSX } from 'react'
import { CodeBlock } from './CodeBlock'
import { drawDiagram, knownDiagram, type Diagram } from './mermaidRender'

/** Whether the app is showing its dark palette (it is, with no page to ask: the test harness). */
const isDark = (): boolean => typeof document === 'undefined' || document.documentElement.dataset.theme !== 'light'

/** The theme, following changes while mounted. */
function useDarkTheme(): boolean {
  const [dark, setDark] = useState(isDark)
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(isDark()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

/**
 * A ```mermaid block drawn as the diagram it describes (mermaidRender.ts),
 * with Show source to read or copy the text it came from. While the diagram
 * is being drawn there is a placeholder, and when Mermaid can't read it the
 * reader gets the ordinary code block, with a line saying so.
 */
export function MermaidBlock({ code }: { code: string }): JSX.Element {
  const dark = useDarkTheme()
  const [showSource, setShowSource] = useState(false)
  const [diagram, setDiagram] = useState<Diagram | null>(() => knownDiagram(code, dark))

  useEffect(() => {
    const known = knownDiagram(code, dark)
    setDiagram(known)
    if (known) return
    let live = true
    void drawDiagram(code, dark).then((result) => {
      if (live) setDiagram(result)
    })
    return () => {
      live = false
    }
  }, [code, dark])

  if (diagram && !diagram.ok) {
    return <CodeBlock lang="mermaid" code={code} tools={<span className="code-block__note">Couldn’t draw this diagram</span>} />
  }

  const toggle = (
    <button
      type="button"
      className="code-block__tool code-block__tool--label"
      aria-pressed={showSource}
      onClick={() => setShowSource(!showSource)}
    >
      {showSource ? 'Show diagram' : 'Show source'}
    </button>
  )
  if (showSource) return <CodeBlock lang="mermaid" code={code} tools={toggle} />

  return (
    <div className="code-block mermaid-block">
      <div className="code-block__head" data-find-skip>
        <span className="code-block__lang">mermaid</span>
        <span className="code-block__tools">{toggle}</span>
      </div>
      <div className="mermaid-block__stage">
        {diagram?.ok ? (
          <img
            className="mermaid-block__img"
            src={diagram.src}
            width={diagram.width ?? undefined}
            height={diagram.height ?? undefined}
            alt="Diagram. Show source for the text it was drawn from."
            draggable={false}
          />
        ) : (
          <span className="mermaid-block__loading" role="status">
            Drawing diagram…
          </span>
        )}
      </div>
    </div>
  )
}
