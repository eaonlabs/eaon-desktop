import { useRef, type JSX, type KeyboardEvent } from 'react'
import { Check, ChevronLeft, ChevronRight, Pipette } from 'lucide-react'
import { WORKER_COLORS, type WorkerMood } from '@shared/workers'
import { shapeSpec, WORKER_SHAPES, type WorkerShape } from '@shared/workerLook'
import { WorkerFace } from './WorkerFace'

/**
 * Choosing a worker's look: the face itself is the picker. Its body is a
 * carousel — the shapes either side of it wait, smaller and faded, and the
 * arrows (or ←/→, or a sideways scroll) bring the next one in — with the
 * shape's name and a row of ticks under it. The colour is a paint strip:
 * one bar of joined swatches, the chosen one lifted out of it, and a dropper
 * at the end for any colour.
 */
export function WorkerLookPicker({
  color,
  shape,
  mood = 'neutral',
  size = 128,
  onColor,
  onShape
}: {
  color: string
  shape: WorkerShape
  mood?: WorkerMood
  size?: number
  onColor: (color: string) => void
  onShape: (shape: WorkerShape) => void
}): JSX.Element {
  const index = Math.max(0, WORKER_SHAPES.findIndex((s) => s.id === shape))
  const at = (offset: number): WorkerShape => WORKER_SHAPES[(index + offset + WORKER_SHAPES.length) % WORKER_SHAPES.length].id
  const wheel = useRef(0)
  const step = (offset: number): void => onShape(at(offset))
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      step(-1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      step(1)
    }
  }
  const custom = !WORKER_COLORS.some((c) => c.toLowerCase() === color.toLowerCase())

  return (
    <div className="look-picker">
      <div
        className="look-carousel"
        role="group"
        aria-label={`Body shape: ${shapeSpec(shape).label}, ${index + 1} of ${WORKER_SHAPES.length}`}
        tabIndex={0}
        onKeyDown={onKey}
        onWheel={(e) => {
          // A trackpad's sideways swipe flips through shapes, one per decent push.
          if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
          wheel.current += e.deltaX
          if (Math.abs(wheel.current) > 60) {
            step(wheel.current > 0 ? 1 : -1)
            wheel.current = 0
          }
        }}
      >
        <button type="button" className="look-carousel__arrow" onClick={() => step(-1)} aria-label="Previous shape">
          <ChevronLeft size={18} strokeWidth={2.2} />
        </button>
        <button type="button" className="look-carousel__side" onClick={() => step(-1)} tabIndex={-1} aria-hidden="true">
          <WorkerFace color={color} shape={at(-1)} size={Math.round(size * 0.42)} mood="neutral" />
        </button>
        <span className="look-carousel__main" key={shape}>
          <WorkerFace color={color} shape={shape} mood={mood} size={size} follow reactOnClick />
        </span>
        <button type="button" className="look-carousel__side" onClick={() => step(1)} tabIndex={-1} aria-hidden="true">
          <WorkerFace color={color} shape={at(1)} size={Math.round(size * 0.42)} mood="neutral" />
        </button>
        <button type="button" className="look-carousel__arrow" onClick={() => step(1)} aria-label="Next shape">
          <ChevronRight size={18} strokeWidth={2.2} />
        </button>
      </div>
      <div className="look-shape-name">
        <span>{shapeSpec(shape).label}</span>
        <span className="look-ticks" aria-hidden="true">
          {WORKER_SHAPES.map((s) => (
            <button key={s.id} type="button" tabIndex={-1} data-on={s.id === shape || undefined} onClick={() => onShape(s.id)} title={s.label} />
          ))}
        </span>
      </div>

      <div className="paint-strip" role="radiogroup" aria-label="Colour">
        {WORKER_COLORS.map((c) => {
          const on = c.toLowerCase() === color.toLowerCase()
          return (
            <button key={c} type="button" role="radio" aria-checked={on} aria-label={c} className="paint-strip__chip" data-on={on || undefined} style={{ background: c }} onClick={() => onColor(c)}>
              {on && <Check size={13} strokeWidth={3} />}
            </button>
          )
        })}
        <label className="paint-strip__chip paint-strip__custom" data-on={custom || undefined} style={custom ? { background: color } : undefined} title="Any colour">
          <Pipette size={13} strokeWidth={2.2} />
          <input type="color" value={color} onChange={(e) => onColor(e.target.value)} aria-label="Pick any colour" />
        </label>
      </div>
    </div>
  )
}
