import { useEffect, useState } from 'react'
import { Check, Download, Info, Mic, Trash2, TriangleAlert, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../../state/store'
import { BrandIcon } from '../../../icons/brand'
import { Select } from '../../ui'
import { AUTO_SPEECH_PROVIDERS, LOCAL_SPEECH_ID, LOCAL_SPEECH_MODELS, SPEECH_PROVIDERS, speechProvider, type LocalSpeechState } from '@shared/speech'
import type { Provider } from '@shared/types'

const AUTO = '__auto'
const OTHER = '__other'

/**
 * The mark for Speech to text in the providers list: a mic on the same
 * neutral tile as a provider's monogram, so it sits with the logos around it.
 */
export function SpeechMark({ size }: { size: number }): JSX.Element {
  return (
    <span className="icon-tile speech-mark" style={{ width: size, height: size, borderRadius: Math.round(size * 0.235) }} aria-hidden="true">
      <Mic size={Math.round(size * 0.5)} strokeWidth={1.9} />
    </span>
  )
}

/**
 * Settings → Model providers → Speech to text: which model turns dictation
 * into text in the Chat and Workers composers. Any provider that serves
 * OpenAI's /audio/transcriptions works — the known ones with their models,
 * a custom or local one (a whisper server) with a model name typed in.
 * Automatic keeps the old behaviour: OpenAI, else Groq.
 */
export function SpeechToTextDetail({ onOpenProvider }: { onOpenProvider: (id: string) => void }): JSX.Element {
  const { settings, patchSettings, providers } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings, providers: s.providers })))
  const voice = settings?.voice ?? { speechProviderId: null, speechModelId: null }
  const [using, setUsing] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    void window.api.voice.provider().then(setUsing, () => setUsing(null))
  }, [voice.speechProviderId, voice.speechModelId, providers])

  // Known speech providers that exist here, then every custom or local one.
  const known = SPEECH_PROVIDERS.map((s) => providers.find((p) => p.id === s.providerId)).filter((p): p is Provider => Boolean(p))
  const own = providers.filter((p) => (!p.builtIn || p.local) && !speechProvider(p.id) && p.baseUrl)
  const choices = [...known, ...own]
  const chosen = voice.speechProviderId ? (providers.find((p) => p.id === voice.speechProviderId) ?? null) : null
  const suggested = voice.speechProviderId ? (speechProvider(voice.speechProviderId)?.models ?? []) : []
  const custom = Boolean(voice.speechModelId) && !suggested.some((m) => m.id === voice.speechModelId)
  const [typing, setTyping] = useState(voice.speechModelId && custom ? voice.speechModelId : '')
  const [other, setOther] = useState(custom)

  const save = (speechProviderId: string | null, speechModelId: string | null): void => {
    if (!settings) return
    void patchSettings({ voice: { speechProviderId, speechModelId } })
  }
  const local = useLocalSpeech()
  const pickProvider = (id: string): void => {
    if (id === AUTO) return save(null, null)
    // On this computer: a model already downloaded if there is one, else the first.
    if (id === LOCAL_SPEECH_ID) return save(LOCAL_SPEECH_ID, local?.downloaded[0] ?? LOCAL_SPEECH_MODELS[0].id)
    const first = speechProvider(id)?.models[0]?.id ?? null
    setOther(!first)
    setTyping('')
    // A custom provider's model is typed in; until it is, dictation keeps choosing automatically.
    save(id, first)
  }
  const isLocal = voice.speechProviderId === LOCAL_SPEECH_ID
  const needsKey = !isLocal && chosen && !chosen.local && chosen.auth !== 'none' && !chosen.hasKey

  return (
    <>
      <div className="provider-detail__header">
        <SpeechMark size={40} />
        <div className="provider-detail__heading">
          <span className="provider-detail__name">Speech to text</span>
          <span className="provider-detail__tagline">The model that turns dictation into text in Chat and Workers</span>
        </div>
      </div>

      <div className="provider-detail__section">
        <div className="provider-detail__section-title">Provider</div>
        <div className="provider-detail__section-desc">
          On this computer, recordings never leave your Mac or PC. A hosted provider gets them with its API key; any that serves
          OpenAI’s <code>/audio/transcriptions</code> works.
        </div>
        <Select
          value={voice.speechProviderId ?? AUTO}
          width={320}
          onChange={pickProvider}
          options={[
            { value: AUTO, label: `Automatic — ${AUTO_SPEECH_PROVIDERS.map((id) => providers.find((p) => p.id === id)?.name ?? id).join(', then ')}` },
            { value: LOCAL_SPEECH_ID, label: 'On this computer — Whisper', icon: <SpeechMark size={16} /> },
            ...choices.map((p) => ({ value: p.id, label: p.name, icon: <BrandIcon id={p.id} name={p.name} size={16} /> }))
          ]}
        />
      </div>

      {isLocal && <LocalModels state={local} selected={voice.speechModelId} onSelect={(id) => save(LOCAL_SPEECH_ID, id)} />}

      {voice.speechProviderId && !isLocal && (
        <div className="provider-detail__section">
          <div className="provider-detail__section-title">Model</div>
          {suggested.length > 0 && (
            <Select
              value={other ? OTHER : (voice.speechModelId ?? suggested[0].id)}
              width={320}
              onChange={(value) => {
                if (value === OTHER) {
                  setOther(true)
                  return
                }
                setOther(false)
                save(voice.speechProviderId, value)
              }}
              options={[...suggested.map((m) => ({ value: m.id, label: m.label })), { value: OTHER, label: 'Another model…' }]}
            />
          )}
          {(other || suggested.length === 0) && (
            <input
              className="input speech-model-input"
              value={typing}
              spellCheck={false}
              placeholder={suggested.length > 0 ? 'Model id, e.g. whisper-1' : 'Model id, e.g. whisper-large-v3'}
              onChange={(e) => setTyping(e.target.value)}
              onBlur={() => typing.trim() && save(voice.speechProviderId, typing.trim())}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && typing.trim()) save(voice.speechProviderId, typing.trim())
              }}
            />
          )}
        </div>
      )}

      <div className="speech-status">
        {needsKey ? (
          <div className="provider-status" data-tone="error">
            <TriangleAlert size={14} strokeWidth={2} />
            <span>
              {chosen.name} has no API key yet, so dictation won’t work.{' '}
              <button className="provider-link" onClick={() => onOpenProvider(chosen.id)}>
                Add one
              </button>
            </span>
          </div>
        ) : isLocal && local && !local.downloaded.includes(voice.speechModelId ?? '') ? (
          <div className="provider-status">
            <Info size={14} strokeWidth={2} />
            <span>Download the selected model to dictate on this computer.</span>
          </div>
        ) : voice.speechProviderId && !voice.speechModelId ? (
          <div className="provider-status">
            <Info size={14} strokeWidth={2} />
            <span>Type the model id this provider serves.</span>
          </div>
        ) : using ? (
          <div className="provider-status">
            <Check size={14} strokeWidth={2.2} />
            <span>
              Dictation uses {using}
              {voice.speechModelId && !isLocal ? ` · ${voice.speechModelId}` : ''}.
            </span>
          </div>
        ) : using === null ? (
          <div className="provider-status" data-tone="error">
            <TriangleAlert size={14} strokeWidth={2} />
            <span>Dictation needs an OpenAI or Groq API key, or pick a provider above that has one.</span>
          </div>
        ) : null}
      </div>
    </>
  )
}

/** The local models' state from main, following downloads as they progress. */
export function useLocalSpeech(): LocalSpeechState | null {
  const [state, setState] = useState<LocalSpeechState | null>(null)
  useEffect(() => {
    let live = true
    void window.api.voice.localState().then((s) => live && setState(s))
    const off = window.api.voice.onLocalChanged((s) => live && setState(s))
    return () => {
      live = false
      off()
    }
  }, [])
  return state
}

const megabytes = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`)

/**
 * The Whisper models that run on this computer: each downloads once, then is
 * picked like any other model. The one in use is checked; a download shows
 * its progress and can be stopped (and picks up again where it stopped).
 */
function LocalModels({ state, selected, onSelect }: { state: LocalSpeechState | null; selected: string | null; onSelect: (id: string) => void }): JSX.Element {
  const [failed, setFailed] = useState<string | null>(null)
  if (state && !state.available) {
    return (
      <div className="provider-detail__section">
        <div className="provider-status" data-tone="error">
          <TriangleAlert size={14} strokeWidth={2} />
          <span>This build of Eaon has no local speech engine for this computer.</span>
        </div>
      </div>
    )
  }
  const download = (id: string): void => {
    setFailed(null)
    // Dictation keeps the model it has until this one is ready; with none
    // downloaded yet, it switches straight away (it can't dictate either way).
    const keep = selected && state?.downloaded.includes(selected)
    if (!keep) onSelect(id)
    window.api.voice.localDownload(id).then(() => onSelect(id), (error: Error) => {
      const message = error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      if (!/abort/i.test(message)) setFailed(message)
    })
  }
  return (
    <div className="provider-detail__section">
      <div className="provider-detail__section-title">Model</div>
      <div className="provider-detail__section-desc">Downloaded once from Hugging Face. Larger models are more accurate and take longer.</div>
      <div className="local-speech" role="radiogroup" aria-label="Speech model">
        {LOCAL_SPEECH_MODELS.map((model) => {
          const have = Boolean(state?.downloaded.includes(model.id))
          const busy = state?.downloading?.id === model.id
          const active = selected === model.id
          return (
            <div key={model.id} className="local-speech__row" data-active={active || undefined}>
              <button
                className="local-speech__pick"
                role="radio"
                aria-checked={active}
                disabled={!have}
                onClick={() => onSelect(model.id)}
                title={have ? `Use ${model.label}` : 'Download it first'}
              >
                <span className="local-speech__dot" aria-hidden="true">
                  {active && have && <Check size={12} strokeWidth={3} />}
                </span>
                <span className="local-speech__text">
                  <span className="local-speech__name">{model.label}</span>
                  <span className="local-speech__blurb">
                    {model.blurb} · {megabytes(model.bytes)}
                  </span>
                </span>
              </button>
              {busy ? (
                <span className="local-speech__progress">
                  <span className="local-speech__bar">
                    <span style={{ width: `${Math.round((state?.downloading?.progress ?? 0) * 100)}%` }} />
                  </span>
                  <span className="local-speech__pct">{Math.round((state?.downloading?.progress ?? 0) * 100)}%</span>
                  <button className="icon-btn" onClick={() => void window.api.voice.localCancel()} aria-label="Stop downloading" title="Stop downloading">
                    <X size={14} strokeWidth={2} />
                  </button>
                </span>
              ) : have ? (
                <button
                  className="icon-btn"
                  onClick={() => {
                    // Deleting the model in use hands dictation to another one that's downloaded.
                    const other = state?.downloaded.find((id) => id !== model.id)
                    if (active && other) onSelect(other)
                    void window.api.voice.localDelete(model.id)
                  }}
                  aria-label={`Delete ${model.label}`} title="Delete from this computer">
                  <Trash2 size={14} strokeWidth={1.9} />
                </button>
              ) : (
                <button className="btn btn--sm" disabled={Boolean(state?.downloading)} onClick={() => download(model.id)}>
                  <Download size={13} strokeWidth={2} />
                  Download
                </button>
              )}
            </div>
          )
        })}
      </div>
      {(failed ?? state?.error) && (
        <div className="provider-status" data-tone="error">
          <TriangleAlert size={14} strokeWidth={2} />
          <span>{failed ?? state?.error}</span>
        </div>
      )}
    </div>
  )
}
