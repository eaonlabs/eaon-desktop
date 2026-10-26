import { useEffect, useRef, useState, type JSX } from 'react'
import { Check, Download, Mic, X } from 'lucide-react'
import { LOCAL_SPEECH_ID, LOCAL_SPEECH_MODELS, localSpeechModel, offeredSpeechModel, type SpeechPick } from '@shared/speech'
import { holdKeyLabel } from '@shared/holdKey'
import { useApp } from '../../state/store'
import { isMac } from '../../lib/platform'
import { SPEECH_SETTINGS, chooseLocalSpeech, downloadSpeechModel, downloadedOf, megabytes, useLocalSpeech } from '../../lib/localSpeech'
import './speechSetup.css'

/** How long "ready" stays up once the model is in, before the card goes by itself. */
const READY_MS = 8000

/**
 * What dictation shows when nothing can turn speech into text yet (Chat's
 * and a worker's message box, the ADE): a model that runs on this computer,
 * downloaded right here, or a way to an API key instead. Once the model is
 * in, it's what dictation uses (in the ADE alone when the ADE has a model of
 * its own), and the card says how to talk.
 */
export function SpeechSetup({
  pick = null,
  holdKey,
  floating = false,
  onClose
}: {
  /** The model picked for this place (the ADE's), or null for the one in Settings. */
  pick?: SpeechPick | null
  /** The hold-to-talk key, when it's on, for the "ready" line. */
  holdKey: string | null
  /** Over the ADE's terminals rather than inside a message box. */
  floating?: boolean
  onClose: () => void
}): JSX.Element | null {
  const voice = useApp((s) => s.settings?.voice)
  const local = useLocalSpeech()
  const [failed, setFailed] = useState<string | null>(null)
  const [ready, setReady] = useState<string | null>(null)
  const close = useRef(onClose)
  close.current = onClose

  // The model this place is set to if it's a local one, else one already here, else the quickest to download.
  const wanted = pick ?? (voice?.speechProviderId ? { providerId: voice.speechProviderId, modelId: voice.speechModelId } : null)
  const model = offeredSpeechModel(wanted?.providerId === LOCAL_SPEECH_ID ? (wanted.modelId ?? LOCAL_SPEECH_MODELS[0].id) : null, local)
  const downloading = local?.downloading ?? null
  const progress = local?.downloading?.progress ?? 0
  const have = Boolean(local?.downloaded.includes(model.id))

  useEffect(() => {
    if (!ready) return
    const timer = window.setTimeout(() => close.current(), READY_MS)
    return () => window.clearTimeout(timer)
  }, [ready])

  const use = (id: string): void => {
    chooseLocalSpeech(id, { ade: Boolean(pick) })
    setReady(localSpeechModel(id, local?.hub)?.label ?? 'The model')
  }
  const download = (): void => {
    setFailed(null)
    downloadSpeechModel(model.id).then(
      (done) => done && use(model.id),
      (error: Error) => setFailed(error.message)
    )
  }
  // The ADE's own model is picked in Settings → ADE; everyone else's under Model providers.
  const openSettings = (): void => {
    onClose()
    if (pick) useApp.getState().setSettingsPage('ade')
    else useApp.getState().openProviderSettings(SPEECH_SETTINGS)
  }

  if (!local) return null
  const key = holdKey ? holdKeyLabel(holdKey, isMac) : null

  let state: 'ready' | 'downloading' | 'offer' | 'unavailable'
  if (ready) state = 'ready'
  else if (downloading) state = 'downloading'
  else if (local.available) state = 'offer'
  else state = 'unavailable'

  return (
    <div className={`speech-setup${floating ? ' speech-setup--floating' : ''}`} data-state={state} role="group" aria-label="Set up dictation">
      <span className="speech-setup__mark" aria-hidden="true">
        {state === 'ready' ? <Check size={15} strokeWidth={2.4} /> : <Mic size={15} strokeWidth={2} />}
      </span>
      <div className="speech-setup__words" aria-live="polite">
        {state === 'ready' ? (
          <>
            <span className="speech-setup__title">{ready} is ready</span>
            <span className="speech-setup__desc">{key ? `Hold ${key} or click the mic, and talk.` : 'Click the mic and talk.'}</span>
          </>
        ) : state === 'downloading' && downloading ? (
          <>
            <span className="speech-setup__title">
              Downloading {downloading.label}
              <span className="speech-setup__count">{downloadedOf(progress, downloading.bytes)}</span>
            </span>
            <span
              className="speech-setup__bar"
              role="progressbar"
              aria-label={`Downloading ${downloading.label}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
            >
              <span style={{ width: `${Math.max(2, Math.round(progress * 100))}%` }} />
            </span>
          </>
        ) : state === 'offer' ? (
          <>
            <span className="speech-setup__title">{have ? `Use ${model.label} to dictate` : 'Set up dictation'}</span>
            <span className="speech-setup__desc" data-tone={failed ? 'error' : undefined}>
              {failed ??
                (have
                  ? 'It runs on this computer, so what you say never leaves it.'
                  : `${model.label} runs on this computer, so what you say never leaves it. ${megabytes(model.bytes)}, downloaded once.`)}
            </span>
          </>
        ) : (
          <>
            <span className="speech-setup__title">Dictation needs a speech model</span>
            <span className="speech-setup__desc">Add an OpenAI or Groq key, or pick another speech model, in Settings.</span>
          </>
        )}
      </div>
      <div className="speech-setup__actions">
        {state === 'downloading' ? (
          <button type="button" className="speech-setup__btn" onClick={() => void window.api.voice.localCancel()}>
            Stop
          </button>
        ) : state === 'offer' ? (
          <>
            <button type="button" className="speech-setup__btn" onClick={openSettings}>
              Use an API key
            </button>
            <button type="button" className="speech-setup__btn speech-setup__btn--go" onClick={() => (have ? use(model.id) : download())}>
              {!have && <Download size={13} strokeWidth={2.2} />}
              {have ? 'Use it' : failed ? 'Try again' : 'Download'}
            </button>
          </>
        ) : state === 'unavailable' ? (
          <button type="button" className="speech-setup__btn speech-setup__btn--go" onClick={openSettings}>
            Open Settings
          </button>
        ) : null}
        {/* Closing mid-download leaves it going: the model is still put to use when it's in. */}
        <button type="button" className="speech-setup__close" onClick={onClose} aria-label="Close" title="Close">
          <X size={13} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  )
}
