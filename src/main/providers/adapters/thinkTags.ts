/**
 * Splits `<think>…</think>` out of streamed content.
 *
 * Open models served without a reasoning parser (vLLM and llama.cpp builds,
 * Groq's Qwen in raw mode, MiniMax's OpenAI endpoint, most distilled R1s) put
 * their chain of thought inline in `content`. Shown as-is it reads as the
 * answer, and replayed as-is it teaches the model to think out loud in its
 * replies.
 *
 * Tags can arrive split across chunks at any byte (`<thi` + `nk>`), so a
 * possible tag prefix at the end of a chunk is held back until the next one
 * decides it. Only a `<think>` at the very start of the reply opens a thinking
 * block: a coding answer that mentions the tag later on stays text.
 */

const OPEN = '<think>'
const CLOSE = '</think>'

export interface SplitPiece {
  text: string
  reasoning: string
}

/** Length of the longest suffix of `value` that is a proper prefix of `tag`. */
function partialTagAt(value: string, tag: string): number {
  const max = Math.min(tag.length - 1, value.length)
  for (let len = max; len > 0; len--) {
    if (tag.startsWith(value.slice(value.length - len))) return len
  }
  return 0
}

export class ThinkTagSplitter {
  /** 'start': nothing but whitespace seen yet; 'think': inside a block; 'text': past it. */
  private mode: 'start' | 'think' | 'text' = 'start'
  private held = ''

  push(chunk: string): SplitPiece {
    const out: SplitPiece = { text: '', reasoning: '' }
    let input = this.held + chunk
    this.held = ''

    while (input.length > 0) {
      if (this.mode === 'start') {
        const trimmed = input.replace(/^\s+/, '')
        if (trimmed.startsWith(OPEN)) {
          this.mode = 'think'
          input = trimmed.slice(OPEN.length)
          continue
        }
        // Could still become `<think>` once more bytes arrive.
        if (trimmed.length < OPEN.length && OPEN.startsWith(trimmed)) {
          this.held = input
          return out
        }
        this.mode = 'text'
        continue
      }

      if (this.mode === 'think') {
        const close = input.indexOf(CLOSE)
        if (close !== -1) {
          out.reasoning += input.slice(0, close)
          // The answer usually starts after a blank line the model wrote for itself.
          input = input.slice(close + CLOSE.length).replace(/^\s+/, '')
          this.mode = 'text'
          continue
        }
        const partial = partialTagAt(input, CLOSE)
        out.reasoning += input.slice(0, input.length - partial)
        this.held = input.slice(input.length - partial)
        return out
      }

      // Text mode. A stray `</think>` (models whose template opens the block in
      // the prompt emit only the closing tag) is dropped rather than shown.
      const stray = input.indexOf(CLOSE)
      if (stray !== -1) {
        out.text += input.slice(0, stray)
        input = input.slice(stray + CLOSE.length)
        continue
      }
      const partial = partialTagAt(input, CLOSE)
      out.text += input.slice(0, input.length - partial)
      this.held = input.slice(input.length - partial)
      return out
    }
    return out
  }

  /** Whatever is still held back once the stream ends. */
  flush(): SplitPiece {
    const held = this.held
    this.held = ''
    if (this.mode === 'think') return { text: '', reasoning: held }
    return { text: held, reasoning: '' }
  }
}
