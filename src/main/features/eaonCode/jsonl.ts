import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'

/**
 * Strict JSONL framing for Eaon Code's RPC stdout.
 *
 * Records are split on LF only, with a trailing CR stripped. Node's `readline`
 * cannot be used: it also breaks lines on U+2028 and U+2029, which are legal
 * unescaped inside JSON strings, so a model that writes either character would
 * split one event into two unparseable halves. The StringDecoder keeps a
 * multi-byte character that straddles two chunks in one piece.
 *
 * Only the new chunk is searched for a newline. Searching the whole buffer
 * made a long record — a resumed session's `get_messages`, a big `agent_end` —
 * quadratic in its length: a 20MB line in 64KB chunks held the main process
 * for ~430ms, against ~8ms this way.
 */
export function attachJsonlReader(stream: Readable, onLine: (line: string) => void): () => void {
  const decoder = new StringDecoder('utf8')
  let buffer = ''

  const emit = (line: string): void => onLine(line.endsWith('\r') ? line.slice(0, -1) : line)

  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let newline = text.indexOf('\n')
    if (newline === -1) {
      buffer += text
      return
    }
    emit(buffer + text.slice(0, newline))
    let start = newline + 1
    newline = text.indexOf('\n', start)
    while (newline !== -1) {
      emit(text.slice(start, newline))
      start = newline + 1
      newline = text.indexOf('\n', start)
    }
    buffer = text.slice(start)
  }
  const onEnd = (): void => {
    buffer += decoder.end()
    if (buffer.length > 0) emit(buffer)
    buffer = ''
  }

  stream.on('data', onData)
  stream.on('end', onEnd)
  return () => {
    stream.off('data', onData)
    stream.off('end', onEnd)
  }
}
