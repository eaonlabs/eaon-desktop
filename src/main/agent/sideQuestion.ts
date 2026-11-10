import { adapterFor, getProvider } from '../providers'
import { credentialAttempts, isAuthError } from '../providers/credentials'
import { clampEffort } from '@shared/effort'
import { SIDE_CONTEXT_CHARS, SIDE_QUESTION_MAX, SIDE_SYSTEM, sideQuestionPrompt, type SideQuestionRequest, type SideQuestionResult } from '@shared/sideQuestion'
import { store } from '../store'
import { buildHistory, transcriptText } from './context'

/**
 * Answers a side question (shared/sideQuestion.ts): one request to the model
 * the chat runs on, with the conversation so far as text and no tools, each
 * saved key tried in turn as in the agent loop. Nothing is written into the
 * chat. The request counts in Settings → Usage like any other the model gets.
 */

const TIMEOUT_MS = 120_000
/** A side answer is short; this keeps a rambling model from running on. */
const OUTPUT_CAP = 2000

export async function askSideQuestion(request: SideQuestionRequest, onText: (delta: string) => void, signal: AbortSignal): Promise<SideQuestionResult> {
  const question = request.question.trim().slice(0, SIDE_QUESTION_MAX)
  if (!question) return { ok: false, error: 'Ask something after /btw.' }
  const provider = getProvider(request.providerId)
  if (!provider) return { ok: false, error: 'That model’s provider isn’t set up any more. Choose another model.' }
  const adapter = adapterFor(provider)
  const model = provider.models.find((m) => m.id === request.modelId)
  const built = buildHistory(request.history, request.summary, store.getSettings().context.keepFullToolTurns)
  const prompt = sideQuestionPrompt(transcriptText(built.messages, SIDE_CONTEXT_CHARS), question)

  const attempts = await credentialAttempts(provider).catch(() => [])
  if (attempts.length === 0) return { ok: false, error: `Sign in to ${provider.name} first, or choose another model.` }
  let failure = 'The model gave no answer.'
  for (let k = 0; k < attempts.length; k++) {
    let streamed = ''
    try {
      const result = await adapter.turn({
        provider,
        modelId: request.modelId,
        model,
        credentials: attempts[k],
        system: SIDE_SYSTEM,
        messages: [{ role: 'user', text: prompt }],
        tools: [],
        // Quick, so little thinking: as much as the model allows below Medium.
        effort: clampEffort('light', model?.efforts) ?? 'none',
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        cacheKey: `eaon-side-question-${provider.id}-${request.modelId}`,
        agentic: false,
        outputCap: OUTPUT_CAP,
        onText: (delta) => {
          streamed += delta
          onText(delta)
        },
        onReasoning: () => {}
      })
      const text = (result.text || streamed).trim()
      return text ? { ok: true, text } : { ok: false, error: result.refusal ?? failure }
    } catch (error) {
      if (signal.aborted) return { ok: false, error: 'Stopped.' }
      if (isAuthError(error) && k < attempts.length - 1) continue
      failure = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error)
      return { ok: false, error: failure }
    }
  }
  return { ok: false, error: failure }
}
