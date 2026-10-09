import { memo, useEffect, useRef, useState, type JSX } from 'react'
import { Ban, Check, Copy, FolderOpen, ImagePlus, TriangleAlert } from 'lucide-react'
import type { ChatToolPart } from '@shared/types'
import { aspectRatio } from '@shared/images'
import { fileName, fileUrl, revealLabel } from '../../lib/files'
import { CLIPBOARD_FAILED, copyText } from '../../lib/clipboard'
import { notify } from '../Notice'
import { generatedPaths, madeWith } from './imageResults'
import { ThinkingOrb } from '../ThinkingOrb'
import { Modal } from '../ui'
import '../../styles/imagegen.css'

/**
 * A `generate_image` call in the transcript. While it runs, one tile per
 * image at the shape that was asked for, each a slowly developing field of
 * light with the current stage on it; when it is done the pictures resolve
 * out of a blur into those same tiles, so nothing jumps. Click one to look at
 * it full size; the corner buttons copy its path or show it in the file
 * manager (Finder on macOS).
 */

const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

/** Seconds since the card first showed, ticking while the call runs. */
function useElapsed(running: boolean): number {
  const started = useRef(Date.now())
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  return Math.max(0, Math.floor((now - started.current) / 1000))
}

function Tile({
  path,
  index,
  ratio,
  stage,
  onOpen
}: {
  path: string | null
  index: number
  ratio: number
  stage: string | null
  onOpen: () => void
}): JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [copied, setCopied] = useState(false)
  const developing = path === null
  return (
    <div
      className="imggen__tile"
      data-state={developing ? 'developing' : loaded ? 'shown' : 'loading'}
      style={{ aspectRatio: String(ratio), ['--i' as string]: index }}
    >
      <span className="imggen__field" aria-hidden="true" />
      <span className="imggen__grain" aria-hidden="true" />
      {developing && <span className="imggen__sweep" aria-hidden="true" />}
      {developing && stage && index === 0 && <span className="imggen__stage">{stage}</span>}
      {path && (
        <>
          <button className="imggen__open" onClick={onOpen} aria-label={`Open ${fileName(path)}`}>
            <img src={fileUrl(path)} alt="" draggable={false} onLoad={() => setLoaded(true)} />
          </button>
          <span className="imggen__actions">
            <button
              className="imggen__action"
              title={copied ? 'Copied' : 'Copy path'}
              aria-label="Copy path"
              onClick={() =>
                void copyText(path).then((ok) => {
                  if (!ok) return notify(CLIPBOARD_FAILED, 'error')
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1400)
                })
              }
            >
              {copied ? <Check size={13} strokeWidth={2.2} /> : <Copy size={13} strokeWidth={2} />}
            </button>
            <button className="imggen__action" title={revealLabel()} aria-label={revealLabel()} onClick={() => void window.api.app.showItem(path).then((shown) => shown || notify("That file isn't there any more.", 'error'))}>
              <FolderOpen size={13} strokeWidth={2} />
            </button>
          </span>
        </>
      )}
    </div>
  )
}

export const ImageGeneration = memo(function ImageGeneration({ part }: { part: ChatToolPart }): JSX.Element {
  const running = part.status === 'running'
  const prompt = typeof part.input.prompt === 'string' ? part.input.prompt : ''
  const editing = Array.isArray(part.input.edit) && part.input.edit.length > 0
  const asked = Math.min(4, Math.max(1, Math.round(Number(part.input.count)) || 1))
  const paths = part.status === 'done' ? generatedPaths(part.output) : []
  const tiles = part.status === 'done' ? paths.length : asked
  const ratio = aspectRatio(part.input.aspect)
  const elapsed = useElapsed(running)
  const [viewing, setViewing] = useState<string | null>(null)

  const title = running
    ? `${editing ? 'Editing' : 'Creating'} ${asked === 1 ? 'image' : `${asked} images`}`
    : part.status === 'done'
      ? `${editing ? 'Edited' : 'Generated'} ${paths.length === 1 ? 'image' : `${paths.length} images`}`
      : part.status === 'denied'
        ? 'Image not generated'
        : "Couldn't generate the image"
  const failed = part.status === 'error' || part.status === 'denied'
  const reason =
    part.status === 'denied' ? 'You declined it, so nothing was billed.' : (part.output ?? '').replace(/^Error:\s*/, '').trim() || 'The provider gave no reason.'

  return (
    <div className="imggen" data-status={part.status} data-count={tiles || 1}>
      <div className="imggen__head">
        <span className="imggen__glyph">
          {running ? (
            <ThinkingOrb size={14} state="working" />
          ) : failed ? (
            part.status === 'denied' ? <Ban size={14} strokeWidth={2} /> : <TriangleAlert size={14} strokeWidth={2} />
          ) : (
            <ImagePlus size={14} strokeWidth={1.9} />
          )}
        </span>
        <span className={`imggen__title${running ? ' shimmer' : ''}`}>{title}</span>
        <span className="imggen__meta">{running ? clock(elapsed) : madeWith(part.output)}</span>
      </div>
      {prompt && <p className="imggen__prompt">{prompt}</p>}

      {failed ? (
        <p className="imggen__error">{reason}</p>
      ) : (
        <div className="imggen__grid">
          {Array.from({ length: tiles }, (_, i) => (
            <Tile
              key={i}
              index={i}
              path={paths[i] ?? null}
              ratio={ratio}
              stage={running ? part.progress ?? 'Starting…' : null}
              onOpen={() => setViewing(paths[i])}
            />
          ))}
        </div>
      )}

      <Modal
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title={viewing ? fileName(viewing) : ''}
        width={820}
        actions={
          viewing && (
            <>
              <button className="btn btn--ghost" onClick={() => void navigator.clipboard.writeText(viewing)}>
                <Copy size={14} strokeWidth={1.9} />
                Copy path
              </button>
              <button className="btn" onClick={() => void window.api.app.showItem(viewing)}>
                <FolderOpen size={14} strokeWidth={1.9} />
                {revealLabel()}
              </button>
            </>
          )
        }
      >
        {viewing && (
          <div className="imggen-view">
            <img src={fileUrl(viewing)} alt={prompt} />
            {prompt && <p className="imggen-view__prompt">{prompt}</p>}
          </div>
        )}
      </Modal>
    </div>
  )
})
