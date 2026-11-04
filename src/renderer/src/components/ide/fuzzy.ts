/**
 * Quick Open's matching (⌘P): the query's letters in order anywhere in a
 * path, the way editors' file finders match. A name beats a folder, the start
 * of a word beats its middle, letters in a run beat scattered ones, and a
 * shorter path wins a tie. Pure, for tests.
 */

export interface FuzzyHit {
  path: string
  score: number
  /** Indexes in `path` of the letters that matched, for bolding. */
  at: number[]
}

const WORD_START = /[\\/_\-.\s]/

/** The path's score for the query, higher is better, or null when the letters aren't all there in order. */
export function fuzzyScore(query: string, path: string): FuzzyHit | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return { path, score: 0, at: [] }
  const p = path.toLowerCase()
  const nameStart = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1
  // Matched from the end of the query backwards, so its last letters land in the file's name when they can.
  const at: number[] = []
  let j = p.length - 1
  for (let i = q.length - 1; i >= 0; i--) {
    while (j >= 0 && p[j] !== q[i]) j--
    if (j < 0) return null
    at.unshift(j)
    j--
  }
  let score = 0
  for (let k = 0; k < at.length; k++) {
    const index = at[k]
    score += 1
    if (index >= nameStart) score += 2
    if (index === 0 || WORD_START.test(path[index - 1]) || (path[index] !== p[index] && path[index - 1] === p[index - 1])) score += 3
    if (k > 0 && at[k - 1] === index - 1) score += 4
  }
  const name = p.slice(nameStart)
  if (name === q) score += 30
  else if (name.startsWith(q)) score += 15
  score -= path.length * 0.05
  return { path, score, at }
}

/** The paths that match, best first, at most `limit`. */
export function fuzzyFind(query: string, paths: string[], limit = 50): FuzzyHit[] {
  const hits: FuzzyHit[] = []
  for (const path of paths) {
    const hit = fuzzyScore(query, path)
    if (hit) hits.push(hit)
  }
  return hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path)).slice(0, limit)
}
