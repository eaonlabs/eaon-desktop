import { useEffect, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { DEFAULT_HOLD_KEY, holdKeyAllowed, holdKeyLabel } from '@shared/holdKey'
import { useApp } from '../../../state/store'
import { isMac } from '../../../lib/platform'
import { Row, Switch } from '../../ui'

/**
 * Hold to talk, for the whole app (composer/useHoldToTalk.ts): whether it is
 * on, and the key. One setting, shown in Settings → General and Settings →
 * ADE; it is stored with the ADE's dictation, where it began.
 */
export function HoldToTalkRows({ description }: { description: string }): JSX.Element {
  const { dictation, patchSettings } = useApp(useShallow((s) => ({ dictation: s.settings?.ade?.dictation, patchSettings: s.patchSettings })))
  const enabled = dictation?.enabled ?? true
  const key = dictation?.key || DEFAULT_HOLD_KEY
  const [listening, setListening] = useState(false)
  const save = (patch: { enabled?: boolean; key?: string }): void => void patchSettings({ ade: { dictation: patch } })

  // Choosing the key: the next key pressed, if it can be held without typing anything.
  useEffect(() => {
    if (!listening) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.code === 'Escape') return setListening(false)
      if (!holdKeyAllowed(e.code)) return
      save({ key: e.code })
      setListening(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // `save` patches the settings; only `listening` starts and stops this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening])

  return (
    <>
      <Row title="Hold to talk" description={description}>
        <Switch label="Hold to talk" checked={enabled} onChange={(on) => save({ enabled: on })} />
      </Row>
      <Row
        title="Key"
        description={
          listening
            ? 'Press the key to hold: Option, Command, Control or Shift on either side, a function key, or Scroll Lock, Pause, Insert or Menu. Esc keeps the one you had.'
            : 'Hold it on its own: pressed with another key it stays a shortcut. Esc while holding cancels.'
        }
      >
        <button type="button" className="btn btn--sm" disabled={!enabled} onClick={() => setListening((on) => !on)} aria-live="polite">
          {listening ? 'Press a key…' : holdKeyLabel(key, isMac)}
        </button>
      </Row>
    </>
  )
}
