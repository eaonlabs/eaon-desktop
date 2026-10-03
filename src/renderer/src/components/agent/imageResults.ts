/**
 * What the transcript reads back from a `generate_image` result. The tool's
 * text lists each saved file on a "- " line (main/features/images/tool.ts).
 */

/** The files the call saved. */
export function generatedPaths(output: string | null): string[] {
  return (output ?? '')
    .split('\n')
    .map((line) => /^- (.+\.(?:png|jpe?g|webp))\s*$/i.exec(line)?.[1] ?? null)
    .filter((path): path is string => path !== null)
}

/** "OpenAI · gpt-image-1", from the result's first line. */
export function madeWith(output: string | null): string | null {
  const match = /with (OpenAI|Gemini) (\S+) \(/.exec(output ?? '')
  return match ? `${match[1]} · ${match[2]}` : null
}
