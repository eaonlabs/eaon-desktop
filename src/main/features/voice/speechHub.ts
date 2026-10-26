import { OFFICIAL_SPEECH_REPO, hubSpeechEnglishOnly, hubSpeechLabel, isSpeechRepo, whisperLanguage, whisperModelFiles, type SpeechHubResult } from '@shared/speech'
import { hfJson } from '../../modelHub'

/**
 * Finding speech models on Hugging Face for dictation on this computer
 * (Settings → Speech to text → Find more): repos with whisper.cpp model
 * files in them, the ones whisper.cpp's own authors publish first. Only
 * whisper.cpp's ggml `.bin` files are offered; GGUF speech models (like the
 * ones Settings → Models finds) need a runtime Eaon doesn't have.
 */

const HF = 'https://huggingface.co'

interface HfRepo {
  id: string
  author?: string
  downloads?: number
  tags?: string[]
  pipeline_tag?: string
  siblings?: { rfilename: string }[]
}

interface HfTreeEntry {
  type: string
  path: string
  size?: number
  lfs?: { oid: string; size: number }
}

/** A file in a repo, as Hugging Face's own listing has it: its size and SHA-256. */
export async function hubFileInfo(repoId: string, filename: string): Promise<{ bytes: number; sha256: string }> {
  const tree = await repoTree(repoId)
  const entry = tree.find((e) => e.path === filename)
  if (!entry?.lfs?.oid) throw new Error(`${filename} isn’t in ${repoId} any more, or isn’t a model file.`)
  return { bytes: entry.lfs.size, sha256: entry.lfs.oid }
}

export const hubFileUrl = (repoId: string, filename: string): string =>
  `${HF}/${repoId.split('/').map(encodeURIComponent).join('/')}/resolve/main/${filename.split('/').map(encodeURIComponent).join('/')}`

const repoTree = (repoId: string): Promise<HfTreeEntry[]> => hfJson<HfTreeEntry[]>(`${HF}/api/models/${repoId}/tree/main?recursive=true`)

/**
 * Repos with whisper.cpp models matching `query` (a language, a model name),
 * or with none, the official models and the most downloaded others. Each
 * file comes with its size, from the repo's own listing.
 */
export async function searchSpeechHub(query: string): Promise<SpeechHubResult[]> {
  const q = query.trim()
  const language = whisperLanguage(q)
  // Hugging Face matches words in repo names. Model makers name whisper.cpp
  // repos "<language>-ggml" or "whisper-…-<code>", so ask both ways (and by
  // the language's codes); with no words, the most downloaded ggml ones.
  const searches = q
    ? [`${q} ggml`, `whisper ${q}`, ...(language?.codes ?? []).flatMap((code) => [`whisper ${code}`, `${code} ggml`])]
    : ['whisper ggml', 'ggml']
  const pages = await Promise.all(
    searches.map((search) =>
      hfJson<HfRepo[]>(`${HF}/api/models?${new URLSearchParams({ search, sort: 'downloads', direction: '-1', limit: '50', full: 'true' })}`).catch(
        (error: Error) => (search === searches[0] ? Promise.reject(error) : [])
      )
    )
  )
  const seen = new Set<string>([OFFICIAL_SPEECH_REPO])
  const repos = pages
    .flat()
    .filter((repo) => !seen.has(repo.id) && Boolean(seen.add(repo.id)))
    .map((repo) => ({ repo, files: whisperModelFiles(repo.id, (repo.siblings ?? []).map((s) => s.rfilename), repo.tags) }))
    // ggml is also the old format of chat models (llama…): only speech ones.
    .filter((r) => r.files.length > 0 && (isSpeechRepo(r.repo) || r.files.some((f) => /whisper/i.test(f))))
    // For a language, its name or code as a word of the repo's name: "de" in "whisper-small-de", not in "distil-dec16".
    .filter((r) => !language || namesLanguage(r.repo.id, language))
    .sort((a, b) => (b.repo.downloads ?? 0) - (a.repo.downloads ?? 0))
    .slice(0, 16)

  // The official repo's id names no model, so a search for "medium" or "turbo"
  // wouldn't find it: look in its files instead. A language search gets its
  // multilingual models, which understand that language too.
  const official = await officialRepo(language ? '' : q, language?.name ?? null)
  const results: SpeechHubResult[] = official ? [official] : []

  const queue = [...repos]
  const sized: SpeechHubResult[] = []
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const next = queue.shift()
        if (!next) return
        const sizes = await repoTree(next.repo.id)
          .then((tree) => new Map(tree.filter((e) => e.lfs).map((e) => [e.path, e.lfs!.size])))
          .catch(() => new Map<string, number>())
        // A file with no size isn't stored as a model (LFS) is: too small to be one.
        const files = next.files.filter((f) => sizes.has(f))
        if (files.length === 0) continue
        sized.push({
          repoId: next.repo.id,
          name: next.repo.id.split('/').pop() ?? next.repo.id,
          author: next.repo.author ?? next.repo.id.split('/')[0],
          downloads: next.repo.downloads ?? 0,
          official: false,
          files: files
            .map((filename) => ({ repoId: next.repo.id, filename, label: hubSpeechLabel(next.repo.id, filename), bytes: sizes.get(filename) ?? 0 }))
            .sort((a, b) => a.bytes - b.bytes)
        })
      }
    })
  )
  sized.sort((a, b) => b.downloads - a.downloads)
  return [...results, ...sized]
}

const namesLanguage = (repoId: string, language: { name: string; codes: string[] }): boolean =>
  repoId.toLowerCase().includes(language.name.toLowerCase()) || new RegExp(`(^|[-_/.])(${language.codes.join('|')})([-_./]|$)`, 'i').test(repoId)

/** whisper.cpp's own models, those whose names match `query` (all of them with none), or for a language the ones that understand it. */
async function officialRepo(query: string, language: string | null): Promise<SpeechHubResult | null> {
  const [tree, meta] = await Promise.all([repoTree(OFFICIAL_SPEECH_REPO), hfJson<HfRepo>(`${HF}/api/models/${OFFICIAL_SPEECH_REPO}`).catch(() => null)])
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const files = whisperModelFiles(
    OFFICIAL_SPEECH_REPO,
    tree.filter((e) => e.lfs).map((e) => e.path)
  )
    .map((filename) => ({
      repoId: OFFICIAL_SPEECH_REPO,
      filename,
      label: hubSpeechLabel(OFFICIAL_SPEECH_REPO, filename),
      bytes: tree.find((e) => e.path === filename)?.lfs?.size ?? 0
    }))
    .filter((f) => words.every((w) => `${f.label} ${f.filename}`.toLowerCase().includes(w)))
    // For a language other than English: the multilingual ones, Small and up (Tiny and Base get most languages wrong).
    .filter((f) => !language || language === 'English' || (!hubSpeechEnglishOnly(f.filename) && !/tiny|base/i.test(f.filename)))
    .sort((a, b) => a.bytes - b.bytes)
  if (files.length === 0) return null
  return {
    repoId: OFFICIAL_SPEECH_REPO,
    name: 'whisper.cpp',
    author: 'ggerganov',
    downloads: meta?.downloads ?? 0,
    official: true,
    files,
    note: language ? `Whisper’s own multilingual models understand ${language} too.` : undefined
  }
}
