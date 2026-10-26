/**
 * Whether a search finds `haystack` (a page's or a row's name and the words
 * people use for it). Each word searched for has to begin a word there, in any
 * order: "port" finds the port setting but not "report" or "import". A plural
 * finds its singular ("goals" finds goal mode, "tours" the tour), and words run
 * together or split apart find each other ("chat gpt" finds ChatGPT, "openai"
 * finds Open AI).
 */
export function matchesSearch(query: string, haystack: string): boolean {
  const asked = wordsOf(query)
  if (asked.length === 0) return true
  const words = wordsOf(haystack)
  // Neighbouring words run together too, so "open ai" in the haystack is found by "openai".
  const candidates = [...words, ...words.slice(1).map((w, i) => words[i] + w)]
  const found = (word: string): boolean => singulars(word).some((form) => candidates.some((w) => w.startsWith(form)))
  if (asked.every(found)) return true
  // "chat gpt" for ChatGPT: the words searched for, run together.
  return asked.length > 1 && found(asked.join(''))
}

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

function singulars(word: string): string[] {
  const forms = [word]
  if (word.length > 4 && word.endsWith('ies')) forms.push(`${word.slice(0, -3)}y`)
  if (word.length > 4 && /(?:ches|shes|sses|xes)$/.test(word)) forms.push(word.slice(0, -2))
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) forms.push(word.slice(0, -1))
  return forms
}
