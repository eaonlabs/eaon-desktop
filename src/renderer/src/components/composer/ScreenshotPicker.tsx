import { useEffect, useState, type JSX } from 'react'
import { Monitor } from 'lucide-react'
import type { CaptureChoice } from '@shared/library'
import { isMac } from '../../lib/platform'
import { Modal } from '../ui'
import './screenshotPicker.css'

type Choices = { state: 'loading' } | { state: 'ready'; choices: CaptureChoice[] } | { state: 'failed'; message: string; permission: boolean }

/**
 * The message box's screenshot button: pick a screen or a window and it is
 * attached as a picture. The previews are taken when this opens and live only
 * here; the one chosen is captured again at that moment and saved as the
 * attachment, and nothing else is kept. With Screen Recording off (macOS) it
 * says so in plain words, with the button that opens the setting.
 */
export function ScreenshotPicker({ open, onClose, onAttach }: { open: boolean; onClose: () => void; onAttach: (paths: string[]) => void }): JSX.Element | null {
  const [choices, setChoices] = useState<Choices>({ state: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    setChoices({ state: 'loading' })
    setBusy(null)
    setError(null)
    void window.api.library.captureChoices().then(
      (result) => {
        if (!live) return
        setChoices(result.ok ? { state: 'ready', choices: result.choices } : { state: 'failed', message: result.message, permission: result.permission })
      },
      () => live && setChoices({ state: 'failed', message: 'The screen couldn’t be captured.', permission: false })
    )
    return () => {
      live = false
      // The previews are dropped with the dialog.
      setChoices({ state: 'loading' })
    }
  }, [open])

  const take = (choice: CaptureChoice): void => {
    if (busy) return
    setBusy(choice.id)
    setError(null)
    void window.api.library.captureAttach(choice.id).then(
      (result) => {
        if (result.ok) {
          onAttach([result.path])
          onClose()
        } else {
          setBusy(null)
          setError(result.message)
        }
      },
      () => {
        setBusy(null)
        setError('The screenshot couldn’t be taken.')
      }
    )
  }

  const screens = choices.state === 'ready' ? choices.choices.filter((c) => c.kind === 'screen') : []
  const windows = choices.state === 'ready' ? choices.choices.filter((c) => c.kind === 'window') : []
  const group = (title: string, list: CaptureChoice[]): JSX.Element | null =>
    list.length === 0 ? null : (
      <section className="shot-pick__group" aria-label={title}>
        <h3 className="shot-pick__label">{title}</h3>
        <div className="shot-pick__grid">
          {list.map((choice) => (
            <button key={choice.id} type="button" className="shot-pick__card" disabled={busy !== null} aria-busy={busy === choice.id} onClick={() => take(choice)} title={choice.name}>
              <img className="shot-pick__thumb" src={choice.preview} alt="" draggable={false} />
              <span className="shot-pick__name">{busy === choice.id ? 'Capturing…' : choice.name}</span>
            </button>
          ))}
        </div>
      </section>
    )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Attach a screenshot"
      width={620}
      actions={
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
      }
    >
      {choices.state === 'loading' && <p className="shot-pick__note">Looking for screens and windows…</p>}
      {choices.state === 'failed' && (
        <div className="shot-pick__failed" role="alert">
          <Monitor size={18} strokeWidth={1.8} />
          <p>{choices.message}</p>
          {choices.permission && isMac && (
            <button type="button" className="btn btn--sm" onClick={() => void window.api.computerUse.openPermission('screen')}>
              Open System Settings
            </button>
          )}
        </div>
      )}
      {choices.state === 'ready' && (
        <>
          <p className="shot-pick__note">Pick a screen or a window. Only the picture you pick is kept, as the attachment.</p>
          {group('Screens', screens)}
          {group('Windows', windows)}
          {error && (
            <p className="shot-pick__error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </Modal>
  )
}
