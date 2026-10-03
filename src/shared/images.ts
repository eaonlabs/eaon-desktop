/**
 * Shapes `generate_image` accepts, shared by the tool (which maps them to
 * each provider's sizes) and the transcript card (which draws its
 * placeholder at the shape that was asked for).
 */
export const IMAGE_ASPECTS = ['square', 'landscape', 'portrait', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'] as const

/** Width over height: square 1, landscape 3:2, portrait 2:3, or the ratio as written. */
export function aspectRatio(aspect: unknown): number {
  if (aspect === 'landscape') return 3 / 2
  if (aspect === 'portrait') return 2 / 3
  const match = /^(\d+):(\d+)$/.exec(typeof aspect === 'string' ? aspect : '')
  return match && Number(match[2]) > 0 ? Number(match[1]) / Number(match[2]) : 1
}
