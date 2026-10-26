import { useState, type JSX } from 'react'
import { Download, X } from 'lucide-react'
import { LOCAL_SPEECH_ID, LOCAL_SPEECH_MODELS, localSpeechModel, offeredSpeechModel } from '@shared/speech'
import { useApp } from '../../../state/store'
import { SPEECH_SETTINGS, chooseLocalSpeech, downloadSpeechModel, downloadedOf, megabytes, useLocalSpeech, useSpeechInUse } from '../../../lib/localSpeech'
import { Row } from '../../ui'
import '../../../styles/providers.css'

/**
 * Settings → General → Speech to text → Model: what dictation listens with,
 * and with nothing set up yet, a model that runs on this computer to download
 * right here. Choosing between all of them is on Settings → Model providers
 * → Speech to text.
 */
export function SpeechModelRow(): JSX.Element {
  const voice = useApp((s) => s.settings?.voice)
  const local = useLocalSpeech()
  const using = useSpeechInUse(local)
  const [failed, setFailed] = useState<string | null>(null)
  // The one to offer: the local model picked if there is one, else one already here, else the quickest to download.
  const model = offeredSpeechModel(voice?.speechProviderId === LOCAL_SPEECH_ID ? (voice.speechModelId ?? LOCAL_SPEECH_MODELS[0].id) : null, local?.downloaded)
  const have = Boolean(local?.downloaded.includes(model.id))
  const progress = local?.downloading ? local.downloading.progress : null
  const downloading = local?.downloading ? (localSpeechModel(local.downloading.id) ?? model) : null
  const offer = using === null && Boolean(local?.available)

  const choose = (): void => useApp.getState().openProviderSettings(SPEECH_SETTINGS)
  const download = (): void => {
    setFailed(null)
    downloadSpeechModel(model.id).then(
      (done) => done && chooseLocalSpeech(model.id),
      (error: Error) => setFailed(error.message)
    )
  }

  const description = failed ? (
    <span className="ch-error">{failed}</span>
  ) : downloading && progress !== null ? (
    `Downloading ${downloading.label}… ${downloadedOf(progress, downloading.bytes)}`
  ) : using ? (
    `Dictation uses ${using}.`
  ) : using === null ? (
    local?.available ? (
      have ? (
        `None in use. ${model.label} is on this computer, ready to listen without sending anything.`
      ) : (
        `None yet. ${model.label} runs on this computer, so what you say never leaves it (${megabytes(model.bytes)}, once).`
      )
    ) : (
      'None yet. Add an OpenAI or Groq key, or pick another model.'
    )
  ) : (
    '\u00a0'
  )

  return (
    <Row title="Model" description={description}>
      {downloading && progress !== null ? (
        <span className="speech-row-progress">
          <span className="local-speech__bar" role="progressbar" aria-label={`Downloading ${downloading.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
          </span>
          <span className="local-speech__pct">{Math.round(progress * 100)}%</span>
          <button type="button" className="icon-btn" onClick={() => void window.api.voice.localCancel()} aria-label="Stop downloading" title="Stop downloading">
            <X size={14} strokeWidth={2} />
          </button>
        </span>
      ) : offer ? (
        <span className="speech-row-actions">
          <button type="button" className="btn btn--sm" onClick={choose}>
            Other models…
          </button>
          <button type="button" className="btn btn--sm btn--primary" onClick={() => (have ? chooseLocalSpeech(model.id) : download())}>
            {!have && <Download size={13} strokeWidth={2} />}
            {have ? 'Use' : 'Download'} {model.label.replace(/^Whisper /, '')}
          </button>
        </span>
      ) : (
        <button type="button" className="btn btn--sm" onClick={choose}>
          Change…
        </button>
      )}
    </Row>
  )
}
