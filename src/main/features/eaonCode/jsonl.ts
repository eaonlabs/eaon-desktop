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
 */
export function attachJsonlReader(stream: Readable, onLine: (line: string) => void): () => void {
  const decoder = new StringDecoder('utf8')
  let buffer = ''

  const emit = (line: string): void => onLine(line.endsWith('\r') ? line.slice(0, -1) : line)

  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      emit(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
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
