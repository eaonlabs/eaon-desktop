import { useEffect, useState } from 'react'
import { Check, Info, Mic, TriangleAlert } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../../state/store'
import { BrandIcon } from '../../../icons/brand'
import { Select } from '../../ui'
import { AUTO_SPEECH_PROVIDERS, SPEECH_PROVIDERS, speechProvider } from '@shared/speech'
import type { Provider } from '@shared/types'

const AUTO = '__auto'
const OTHER = '__other'

/** The mark for Speech to text in the providers list, sized like a provider's logo. */
export function SpeechMark({ size }: { size: number }): JSX.Element {
  return (
    <span className="speech-mark" style={{ width: size, height: size }} aria-hidden="true">
      <Mic size={Math.round(size * 0.56)} strokeWidth={2.1} />
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
  const pickProvider = (id: string): void => {
    if (id === AUTO) return save(null, null)
    const first = speechProvider(id)?.models[0]?.id ?? null
    setOther(!first)
    setTyping('')
    // A custom provider's model is typed in; until it is, dictation keeps choosing automatically.
    save(id, first)
  }
  const needsKey = chosen && !chosen.local && chosen.auth !== 'none' && !chosen.hasKey

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
          Recordings go to this provider with its API key. Any provider that serves OpenAI’s <code>/audio/transcriptions</code>{' '}
          works, including a local Whisper server added as a custom provider.
        </div>
        <Select
          value={voice.speechProviderId ?? AUTO}
          width={320}
          onChange={pickProvider}
          options={[
            { value: AUTO, label: `Automatic — ${AUTO_SPEECH_PROVIDERS.map((id) => providers.find((p) => p.id === id)?.name ?? id).join(', then ')}` },
            ...choices.map((p) => ({ value: p.id, label: p.name, icon: <BrandIcon id={p.id} name={p.name} size={16} /> }))
          ]}
        />
      </div>

      {voice.speechProviderId && (
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
              {voice.speechModelId ? ` · ${voice.speechModelId}` : ''}.
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
