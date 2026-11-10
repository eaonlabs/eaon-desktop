import type { NeutralMessage } from '../providers/adapters/types'

/**
 * Checks the loop applies to tool calls so a model cannot spin in place:
 * the same failing call re-issued unchanged, the same observation re-read
 * into context, rounds in a row that get nowhere, or a goal declared done
 * straight after an unchecked change. Pure bookkeeping — the loop decides
 * what to do with the answers.
 */

/** JSON with sorted keys, so `{a,b}` and `{b,a}` are the same call. */
export function callSignature(name: string, input: Record<string, unknown>): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => [key, stable((value as Record<string, unknown>)[key])])
      )
    }
    return value
  }
  return `${name}:${JSON.stringify(stable(input))}`
}

/** How many identical failures in a row before the call is refused outright. */
export const MAX_IDENTICAL_FAILURES = 3

/**
 * Observations shorter than this are cheaper to resend than to explain.
 * Above it, an unchanged repeat is replaced by a pointer to the earlier copy.
 */
const DEDUPE_MIN_CHARS = 400

/**
 * How far back an earlier result may be and still be pointed at. In-flight
 * pruning keeps the last four tool messages whole and Anthropic's context
 * editing keeps the last six tool uses; staying inside both means the
 * pointed-at copy is still in what the model sees.
 */
const DEDUPE_LOOKBACK_RESULTS = 5

/**
 * Rounds in a row that may go by without changing anything or learning
 * anything new (a call not made since the last change, or one whose result
 * is different this time, like a build log being watched) before the reply
 * is called stuck. With no step limit, this ends a reply going round in circles.
 */
export const MAX_IDLE_ROUNDS = 12

export class CallGuard {
  private failures = new Map<string, { count: number; last: string }>()
  private observations = new Map<string, { id: string; output: string }>()
  /** Calls made since the last change, with what each returned last. */
  private tried = new Map<string, string>()
  private progressed = false
  private idle = 0

  /** Before a call runs: a reason to refuse it, or null to go ahead. */
  refuse(name: string, input: Record<string, unknown>): string | null {
    const failed = this.failures.get(callSignature(name, input))
    if (!failed || failed.count < MAX_IDENTICAL_FAILURES) return null
    return (
      `Not run: this exact ${name} call has already failed ${failed.count} times with the same arguments and nothing has changed since. ` +
      `Its last error was: ${failed.last.slice(0, 300)}\n` +
      'Change something first — different arguments, a different tool, or a fix to what caused the error. If you cannot get past this, say plainly what is blocking you.'
    )
  }

  /**
   * After a call ran. Returns a note to append to the result when the model
   * should hear that it is repeating itself.
   */
  record(name: string, input: Record<string, unknown>, status: 'done' | 'denied' | 'error', output: string, changedSomething: boolean): string | null {
    const signature = callSignature(name, input)
    // A successful change (an edit, a command that did something) can make a
    // call that failed before succeed now, so every failure count starts over.
    if (changedSomething && status === 'done') {
      this.failures.clear()
      this.observations.clear()
      this.tried.clear()
      this.progressed = true
      return null
    }
    if (this.tried.get(signature) !== output) {
      this.tried.set(signature, output)
      this.progressed = true
    }
    if (status === 'done') {
      this.failures.delete(signature)
      return null
    }
    if (status !== 'error') return null
    const count = (this.failures.get(signature)?.count ?? 0) + 1
    this.failures.set(signature, { count, last: output })
    return count === 2
      ? '\n\n[Note: this identical call has now failed twice. Retrying it unchanged will not help — change the approach.]'
      : null
  }

  /**
   * After each round of calls: how many rounds in a row now have changed
   * nothing and only repeated calls for the same results as before.
   */
  endRound(): number {
    this.idle = this.progressed ? 0 : this.idle + 1
    this.progressed = false
    return this.idle
  }

  /**
   * For a successful read-only call: the text the model should get instead of
   * `output` when it has just seen exactly this output from exactly this call,
   * or null to send the output as it is.
   */
  dedupe(name: string, input: Record<string, unknown>, id: string, output: string, messages: NeutralMessage[]): string | null {
    const signature = callSignature(name, input)
    const earlier = this.observations.get(signature)
    this.observations.set(signature, { id, output })
    if (!earlier || output.length < DEDUPE_MIN_CHARS || earlier.output !== output) return null
    if (!recentlyVisible(messages, earlier.id, output)) return null
    // The model is pointed at the earlier copy, which stays the one to refer to.
    this.observations.set(signature, earlier)
    return `(Same result as your earlier identical ${name} call — nothing has changed since. Use that result instead of repeating the call.)`
  }
}

/** True when result `id` is among the most recent tool results and still holds `output` unpruned. */
function recentlyVisible(messages: NeutralMessage[], id: string, output: string): boolean {
  let seen = 0
  for (let i = messages.length - 1; i >= 0 && seen < DEDUPE_LOOKBACK_RESULTS; i--) {
    const message = messages[i]
    if (message.role !== 'tool') continue
    for (let j = message.results.length - 1; j >= 0 && seen < DEDUPE_LOOKBACK_RESULTS; j--, seen++) {
      const result = message.results[j]
      if (result.id === id) return result.output === output
    }
  }
  return false
}
