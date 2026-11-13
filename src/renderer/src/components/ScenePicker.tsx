import { useEffect, useRef, useState, type JSX } from 'react'
import { create } from 'zustand'
import { Check } from 'lucide-react'
import { CHAT_SCENES, CHAT_SCENE_LABELS, type ChatScene } from '@shared/chatScenes'
import { useApp } from '../state/store'
import { ChatScene as SceneView } from './ChatScene'

/**
 * `/theme`: the scenes behind the chat, as a row of previews docked above the
 * message box. ← → move, ⏎ or a click applies, esc closes.
 */

export const useScenePicker = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({ open: false, setOpen: (open) => set({ open }) }))

/** How far into a scene its preview is drawn: far enough that everything is in view. */
const PREVIEW_AT = 16

export function ScenePicker(): JSX.Element | null {
  const open = useScenePicker((s) => s.open)
  const setOpen = useScenePicker((s) => s.setOpen)
  const current = useApp((s) => s.settings?.appearance.chatScene ?? 'off')
  const patchSettings = useApp((s) => s.patchSettings)
  const [index, setIndex] = useState(0)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setIndex(Math.max(0, CHAT_SCENES.indexOf(current)))
    panel.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null
  const apply = (scene: ChatScene): void => void patchSettings({ appearance: { chatScene: scene } })
  const close = (): void => setOpen(false)

  return (
    <div
      ref={panel}
      className="scene-picker"
      role="listbox"
      aria-label="Chat background"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          close()
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault()
          setIndex((i) => (i + (e.key === 'ArrowRight' ? 1 : -1) + CHAT_SCENES.length) % CHAT_SCENES.length)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          apply(CHAT_SCENES[index])
          close()
        }
      }}
    >
      <div className="scene-picker__top">
        <span className="scene-picker__tag">/theme</span>
        <span className="scene-picker__title">Chat backgrounds</span>
        <span className="scene-picker__keys">↵ apply · esc close</span>
      </div>
      <div className="scene-picker__row">
        {CHAT_SCENES.map((scene, i) => (
          <button
            key={scene}
            type="button"
            role="option"
            aria-selected={scene === current}
            className="scene-card"
            data-focus={i === index || undefined}
            data-active={scene === current || undefined}
            onMouseEnter={() => setIndex(i)}
            onClick={() => {
              apply(scene)
              close()
            }}
          >
            <span className="scene-card__thumb">
              {scene === 'off' ? <span className="scene-card__none">No scene</span> : <SceneView scene={scene} zoom={0.22} at={PREVIEW_AT} className="chat-scene chat-scene--thumb" />}
            </span>
            <span className="scene-card__label">
              {CHAT_SCENE_LABELS[scene]}
              {scene === current && <Check size={13} strokeWidth={2.4} aria-hidden />}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
