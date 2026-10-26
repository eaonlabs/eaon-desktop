import { useEffect, useState } from 'react'
import { Check, Download, Info, Mic, RefreshCw, Trash2, TriangleAlert, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../../state/store'
import { BrandIcon } from '../../../icons/brand'
import { Select } from '../../ui'
import {
  AUTO_SPEECH_PROVIDERS,
  LOCAL_SPEECH_ID,
  LOCAL_SPEECH_MODELS,
  SPEECH_PROVIDERS,
  canTranscribe,
  localSpeechModel,
  looksLikeSpeechModel,
  speechProvider,
  type LocalSpeechModel,
  type LocalSpeechState
} from '@shared/speech'
import type { Provider } from '@shared/types'
import { downloadSpeechModel, downloadedOf, megabytes, useLocalSpeech, useSpeechInUse } from '../../../lib/localSpeech'
import { SpeechHub } from './SpeechHub'

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
 * into text in Chat, Workers and the ADE. First the models that run on this
 * computer, each with its download, so getting dictation going never needs
 * a key, and any other whisper.cpp model from Hugging Face; then the
 * online ones: any provider that serves OpenAI's /audio/transcriptions
 * works — the known ones with their models, a custom one (a whisper server)
 * with the models it lists. Automatic keeps the old behaviour: OpenAI, else
 * Groq. Chat-only runtimes (Ollama, the chat models "On this computer"…)
 * can't transcribe, so they aren't offered.
 */
export function SpeechToTextDetail({ onOpenProvider }: { onOpenProvider: (id: string) => void }): JSX.Element {
  const { settings, patchSettings, providers } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings, providers: s.providers })))
  const voice = settings?.voice ?? { speechProviderId: null, speechModelId: null }
  const local = useLocalSpeech()
  const using = useSpeechInUse(local)

  // Known speech providers that exist here, then every custom or local one that could serve speech.
  const known = SPEECH_PROVIDERS.map((s) => providers.find((p) => p.id === s.providerId)).filter((p): p is Provider => Boolean(p))
  const own = providers.filter((p) => (!p.builtIn || p.local) && !speechProvider(p.id) && p.baseUrl && canTranscribe(p))
  const choices = [...known, ...own]
  const isLocal = voice.speechProviderId === LOCAL_SPEECH_ID
  const chosen = voice.speechProviderId && !isLocal ? (providers.find((p) => p.id === voice.speechProviderId) ?? null) : null
  // The models to choose from: the ones known for this provider, else the ones it lists itself, speech-like first.
  const listed = chosen ? [...chosen.models].sort((a, b) => Number(looksLikeSpeechModel(b.id)) - Number(looksLikeSpeechModel(a.id))) : []
  const suggested = chosen ? (speechProvider(chosen.id)?.models ?? listed.map((m) => ({ id: m.id, label: m.label && m.label !== m.id && !m.id.endsWith(`/${m.label}`) ? `${m.label} (${m.id})` : m.id }))) : []
  const custom = Boolean(voice.speechModelId) && !suggested.some((m) => m.id === voice.speechModelId)
  const [typing, setTyping] = useState(voice.speechModelId && custom ? voice.speechModelId : '')
  const [other, setOther] = useState(custom)
  const [refreshing, setRefreshing] = useState(false)

  // Picked before chat-only runtimes were left out of the list (a GGUF Whisper
  // under "On this computer", say): it never worked, so say so and start over.
  const [dropped, setDropped] = useState<string | null>(null)
  useEffect(() => {
    const id = voice.speechProviderId
    if (!settings || !id || canTranscribe({ id })) return
    setDropped(providers.find((p) => p.id === id)?.name ?? id)
    void patchSettings({ voice: { speechProviderId: null, speechModelId: null } })
  }, [settings, voice.speechProviderId, providers, patchSettings])

  const save = (speechProviderId: string | null, speechModelId: string | null): void => {
    if (!settings) return
    void patchSettings({ voice: { speechProviderId, speechModelId } })
  }
  const pickProvider = (id: string): void => {
    if (id === AUTO) return save(null, null)
    const provider = providers.find((p) => p.id === id)
    const first = speechProvider(id)?.models[0]?.id ?? provider?.models.find((m) => looksLikeSpeechModel(m.id))?.id ?? provider?.models[0]?.id ?? null
    setOther(!first)
    setTyping('')
    // A custom provider's model is typed in; until it is, dictation keeps choosing automatically.
    save(id, first)
  }
  const needsKey = Boolean(chosen && !chosen.local && chosen.auth !== 'none' && !chosen.hasKey)
  const localModel = isLocal ? (localSpeechModel(voice.speechModelId, local?.hub) ?? (local ? LOCAL_SPEECH_MODELS[0] : null)) : null
  const refresh = (): void => {
    if (!chosen) return
    setRefreshing(true)
    void window.api.providers
      .refreshModels(chosen.id)
      .then(() => useApp.getState().refreshProviders())
      .finally(() => setRefreshing(false))
  }

  return (
    <>
      <div className="provider-detail__header">
        <SpeechMark size={40} />
        <div className="provider-detail__heading">
          <span className="provider-detail__name">Speech to text</span>
          <span className="provider-detail__tagline">The model that turns dictation into text in Chat, Workers and the ADE</span>
        </div>
      </div>

      <div className="speech-status">
        {dropped && !voice.speechProviderId ? (
          <div className="provider-status">
            <Info size={14} strokeWidth={2} />
            <span>
              Dictation was set to {dropped}, which runs chat models and can’t turn speech into text. Pick a speech model below: one on this
              computer is free.
            </span>
          </div>
        ) : needsKey && chosen ? (
          <div className="provider-status" data-tone="error">
            <TriangleAlert size={14} strokeWidth={2} />
            <span>
              {chosen.name} has no API key yet, so dictation won’t work.{' '}
              <button className="provider-link" onClick={() => onOpenProvider(chosen.id)}>
                Add one
              </button>
            </span>
          </div>
        ) : localModel && local && !local.downloaded.includes(localModel.id) ? (
          <div className="provider-status">
            <Info size={14} strokeWidth={2} />
            <span>Download {localModel.label} below to dictate on this computer.</span>
          </div>
        ) : chosen && !voice.speechModelId ? (
          <div className="provider-status">
            <Info size={14} strokeWidth={2} />
            <span>Type the model id {chosen.name} serves.</span>
          </div>
        ) : using ? (
          <div className="provider-status" data-tone="ok">
            <Check size={14} strokeWidth={2.2} />
            <span>
              Dictation uses {using}
              {voice.speechModelId && chosen ? ` · ${voice.speechModelId}` : ''}.
            </span>
          </div>
        ) : using === null ? (
          <div className="provider-status">
            <Info size={14} strokeWidth={2} />
            <span>Nothing to dictate with yet. Download a model that runs on this computer, or add an OpenAI or Groq key.</span>
          </div>
        ) : null}
      </div>

      <div className="provider-detail__section">
        <div className="provider-detail__section-title">On this computer</div>
        <div className="provider-detail__section-desc">
          Free and private: recordings never leave this computer. Download one and it’s used straight away; each is checked before it’s used.
        </div>
        <LocalSpeechModels state={local} selected={localModel?.id ?? null} onSelect={(id) => save(LOCAL_SPEECH_ID, id)} />
        {local?.available !== false && <SpeechHub state={local} selected={localModel?.id ?? null} onSelect={(id) => save(LOCAL_SPEECH_ID, id)} />}
      </div>

      <div className="provider-detail__section">
        <div className="provider-detail__section-title">Online</div>
        <div className="provider-detail__section-desc">
          A provider transcribes the recording with your API key. Any that serves OpenAI’s <code>/audio/transcriptions</code> works.
        </div>
        {isLocal ? (
          <div className="speech-online-off">
            <span>Not in use while dictation runs on this computer.</span>
            <button type="button" className="btn btn--sm" onClick={() => save(null, null)}>
              Use online instead
            </button>
          </div>
        ) : (
          <>
            <Select
              value={voice.speechProviderId ?? AUTO}
              width={320}
              label="Online provider"
              onChange={pickProvider}
              options={[
                { value: AUTO, label: `Automatic — ${AUTO_SPEECH_PROVIDERS.map((id) => providers.find((p) => p.id === id)?.name ?? id).join(', then ')}` },
                ...choices.map((p) => ({ value: p.id, label: p.name, icon: <BrandIcon id={p.id} name={p.name} size={16} /> }))
              ]}
            />
            {chosen && suggested.length === 0 && (
              <div className="speech-online-empty">
                <span>{chosen.name} hasn’t listed its models yet.</span>
                <button type="button" className="btn btn--sm" disabled={refreshing} onClick={refresh}>
                  <RefreshCw size={13} strokeWidth={2} className={refreshing ? 'spinner' : undefined} />
                  {refreshing ? 'Asking…' : 'Get its models'}
                </button>
              </div>
            )}
            {chosen && suggested.length > 0 && (
              <div className="speech-online-model">
                <Select
                  value={other ? OTHER : (voice.speechModelId ?? suggested[0].id)}
                  width={320}
                  label="Online model"
                  onChange={(value) => {
                    if (value === OTHER) {
                      setOther(true)
                      return
                    }
                    setOther(false)
                    save(chosen.id, value)
                  }}
                  options={[...suggested.map((m) => ({ value: m.id, label: m.label })), { value: OTHER, label: 'Another model…' }]}
                />
              </div>
            )}
            {chosen && other && (
              <input
                aria-label="Model id"
                className="input speech-model-input"
                value={typing}
                spellCheck={false}
                placeholder="The model’s id, as the provider names it"
                onChange={(e) => setTyping(e.target.value)}
                onBlur={() => typing.trim() && save(chosen.id, typing.trim())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && typing.trim()) save(chosen.id, typing.trim())
                }}
              />
            )}
          </>
        )}
      </div>
    </>
  )
}

/**
 * The Whisper models that run on this computer: the three listed, then any
 * downloaded from Hugging Face. Each downloads once and is put to use as soon
 * as it's in; after that it's picked like a radio button. The one in use is
 * checked; a download shows how far it has come and can be stopped (and picks
 * up again where it stopped).
 */
export function LocalSpeechModels({
  state,
  selected,
  onSelect
}: {
  state: LocalSpeechState | null
  /** The local model dictation uses, or null when it uses an online one. */
  selected: string | null
  onSelect: (id: string) => void
}): JSX.Element {
  const [failed, setFailed] = useState<string | null>(null)
  if (state && !state.available) {
    return (
      <div className="provider-status" data-tone="error">
        <TriangleAlert size={14} strokeWidth={2} />
        <span>This build of Eaon has no local speech engine for this computer.</span>
      </div>
    )
  }
  const download = (id: string): void => {
    setFailed(null)
    downloadSpeechModel(id).then(
      (done) => done && onSelect(id),
      (error: Error) => setFailed(error.message)
    )
  }
  // A Hugging Face model still downloading has a row of its own until it's in.
  const pending = state?.downloading && !localSpeechModel(state.downloading.id, state.hub) ? state.downloading : null
  const rows: LocalSpeechModel[] = [
    ...LOCAL_SPEECH_MODELS,
    ...(state?.hub ?? []),
    ...(pending ? [{ id: pending.id, label: pending.label, blurb: '', file: '', bytes: pending.bytes, sha256: '', repoId: 'hub' }] : [])
  ]
  return (
    <>
      <div className="local-speech" role="radiogroup" aria-label="Speech models on this computer">
        {rows.map((model) => {
          const have = Boolean(state?.downloaded.includes(model.id))
          const progress = state?.downloading?.id === model.id ? state.downloading.progress : null
          const active = have && selected === model.id
          return (
            <div key={model.id} className="local-speech__row" data-active={active || undefined} data-busy={progress !== null || undefined}>
              <button
                className="local-speech__pick"
                role="radio"
                aria-checked={active}
                disabled={!have}
                onClick={() => onSelect(model.id)}
                title={have ? (active ? 'In use' : `Use ${model.label}`) : 'Download it first'}
              >
                <span className="local-speech__dot" aria-hidden="true">
                  {active && <Check size={12} strokeWidth={3} />}
                </span>
                <span className="local-speech__text">
                  <span className="local-speech__name">
                    {model.label}
                    {active && <span className="local-speech__tag">In use</span>}
                  </span>
                  <span className="local-speech__blurb">
                    {progress !== null
                      ? `Downloading… ${downloadedOf(progress, model.bytes)}`
                      : model.repoId
                        ? `From ${model.blurb} on Hugging Face · ${megabytes(model.bytes)}`
                        : `${model.blurb} · ${megabytes(model.bytes)}`}
                  </span>
                </span>
              </button>
              {progress !== null ? (
                <span className="local-speech__progress">
                  <span
                    className="local-speech__bar"
                    role="progressbar"
                    aria-label={`Downloading ${model.label}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(progress * 100)}
                  >
                    <span style={{ width: `${Math.round(progress * 100)}%` }} />
                  </span>
                  <span className="local-speech__pct">{Math.round(progress * 100)}%</span>
                  <button className="icon-btn" onClick={() => void window.api.voice.localCancel()} aria-label="Stop downloading" title="Stop downloading">
                    <X size={14} strokeWidth={2} />
                  </button>
                </span>
              ) : have ? (
                <button
                  className="icon-btn local-speech__delete"
                  onClick={() => {
                    // Deleting the model in use hands dictation to another one that's downloaded.
                    const next = state?.downloaded.find((id) => id !== model.id)
                    if (active && next) onSelect(next)
                    void window.api.voice.localDelete(model.id)
                  }}
                  aria-label={`Delete ${model.label}`}
                  title="Delete from this computer"
                >
                  <Trash2 size={14} strokeWidth={1.9} />
                </button>
              ) : (
                <button className="btn btn--sm local-speech__get" disabled={Boolean(state?.downloading)} onClick={() => download(model.id)}>
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
    </>
  )
}
