import { useCallback, useEffect, useRef, useState } from 'react'

export type DictationState = 'idle' | 'starting' | 'recording' | 'transcribing'

/** What was said, added to what is already typed, with one space between. */
export function joinTranscript(existing: string, spoken: string): string {
  const said = spoken.trim()
  if (!said) return existing
  if (!existing.trim()) return said
  return /\s$/.test(existing) ? existing + said : `${existing} ${said}`
}

/** Longer recordings stop by themselves: providers cap uploads, and a forgotten mic shouldn't run on. */
export const MAX_RECORDING_MS = 10 * 60 * 1000

export interface Dictation {
  state: DictationState
  error: string | null
  /** When recording started, for the timer. */
  startedAt: number
  /** Live input for the waveform while recording; null otherwise. */
  analyser: AnalyserNode | null
  start: () => Promise<void>
  /** Stops and transcribes. */
  finish: () => void
  /** Stops and throws the recording away. */
  cancel: () => void
  dismissError: () => void
}

interface Session {
  stream: MediaStream
  context: AudioContext
  recorder: MediaRecorder
  chunks: Blob[]
  mimeType: string
  limit: ReturnType<typeof setTimeout>
  discard: boolean
}

function pickMimeType(): string {
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}

/**
 * Dictation for a composer: records the microphone, shows its level, and
 * hands the transcript to `onText`. Text is never sent on its own; it lands
 * in the message box for the user to read first.
 */
export function useDictation(onText: (text: string) => void): Dictation {
  const [state, setState] = useState<DictationState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [startedAt, setStartedAt] = useState(0)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const session = useRef<Session | null>(null)
  const textHandler = useRef(onText)
  textHandler.current = onText

  const release = useCallback((current: Session): void => {
    clearTimeout(current.limit)
    for (const track of current.stream.getTracks()) track.stop()
    void current.context.close().catch(() => {})
    if (session.current === current) session.current = null
    setAnalyser(null)
  }, [])

  const finish = useCallback((): void => {
    const current = session.current
    if (!current || current.recorder.state === 'inactive') return
    current.discard = false
    current.recorder.stop()
  }, [])

  const cancel = useCallback((): void => {
    const current = session.current
    if (!current) return
    current.discard = true
    if (current.recorder.state !== 'inactive') current.recorder.stop()
    else release(current)
    setState('idle')
  }, [release])

  const start = useCallback(async (): Promise<void> => {
    if (session.current) return
    setError(null)
    setState('starting')
    try {
      // Before recording, so nobody talks for a minute only to be told there's no key.
      if (!(await window.api.voice.provider())) {
        setError('Dictation needs an OpenAI or Groq API key. Add one in Settings → Model providers.')
        setState('idle')
        return
      }
      if ((await window.api.voice.microphone()) === 'denied') {
        setError('Eaon isn’t allowed to use the microphone. Turn it on in System Settings → Privacy & Security → Microphone.')
        setState('idle')
        return
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
      const context = new AudioContext()
      const node = context.createAnalyser()
      node.fftSize = 1024
      node.smoothingTimeConstant = 0.2
      context.createMediaStreamSource(stream).connect(node)

      const mimeType = pickMimeType()
      const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 })
      const current: Session = {
        stream,
        context,
        recorder,
        chunks: [],
        mimeType: recorder.mimeType || mimeType || 'audio/webm',
        limit: setTimeout(() => finish(), MAX_RECORDING_MS),
        discard: false
      }
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) current.chunks.push(event.data)
      }
      recorder.onstop = () => {
        release(current)
        if (current.discard) return
        setState('transcribing')
        void (async () => {
          try {
            const audio = new Uint8Array(await new Blob(current.chunks, { type: current.mimeType }).arrayBuffer())
            const result = await window.api.voice.transcribe(audio, current.mimeType)
            if (!result.ok) setError(result.error)
            else if (!result.text) setError('Didn’t catch anything. Try again a little closer to the mic.')
            else textHandler.current(result.text)
          } catch (failure) {
            setError((failure as Error).message)
          } finally {
            setState('idle')
          }
        })()
      }
      session.current = current
      recorder.start(250)
      setAnalyser(node)
      setStartedAt(Date.now())
      setState('recording')
    } catch (failure) {
      const name = (failure as DOMException).name
      setError(
        name === 'NotAllowedError'
          ? 'Eaon isn’t allowed to use the microphone. Turn it on in System Settings → Privacy & Security → Microphone.'
          : name === 'NotFoundError'
            ? 'No microphone found.'
            : `Couldn’t start recording: ${(failure as Error).message}`
      )
      setState('idle')
    }
  }, [finish, release])

  // Leaving the view stops the microphone; a recording nobody finished is dropped.
  useEffect(() => () => session.current?.recorder && cancel(), [cancel])

  return { state, error, startedAt, analyser, start, finish, cancel, dismissError: () => setError(null) }
}
