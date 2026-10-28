/**
 * How far along a compaction is, 0–1, for the strip above the message box.
 *
 * A summary is made in two stretches: the model reads the transcript, when
 * nothing arrives yet, then writes the summary a few words at a time. Reading
 * fills the first tenth as the seconds pass; writing fills the rest by how
 * much of the expected summary has arrived. It holds at 95% until the summary
 * is in, so the bar is never full while the work goes on.
 */
export function compactionProgress(elapsedMs: number, writtenChars: number, expectedChars: number): number {
  const reading = 0.1 * (1 - Math.exp(-Math.max(0, elapsedMs) / 4000))
  if (writtenChars <= 0) return reading
  const writing = 0.1 + 0.85 * Math.min(1, writtenChars / Math.max(1, expectedChars))
  return Math.min(0.95, Math.max(reading, writing))
}

/**
 * About how long a summary of this transcript runs: the compaction prompt asks
 * for compact notes, which come to roughly an eighth of what they cover, and
 * seldom less than a short page or more than a few.
 */
export function expectedSummaryChars(transcriptChars: number): number {
  return Math.round(Math.min(8000, Math.max(1200, transcriptChars * 0.12)))
}
