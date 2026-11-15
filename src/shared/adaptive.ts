import type { EffortLevel, Provider, RouteRecord } from './types'
import type { ModelOption } from './modelSelection'
import { clampEffort, EFFORT_LABEL } from './effort'

/**
 * Adaptive, the model picker's first row: each message goes to the model that
 * suits it, from those the user can use now, at the effort it needs. A quick
 * question gets a fast model thinking little; a coding task a strong
 * all-rounder; a hard problem (an architecture, a stubborn bug, a whole app)
 * the most capable model. Nothing is asked of a model to decide: the message
 * is read here, so choosing costs no tokens and no time.
 *
 * Models are told apart by what their names and descriptions say (Haiku,
 * Luna, "Fast and affordable…" are fast; Opus, Fable, Astra, "Frontier
 * intelligence…" are the most capable; the rest are all-rounders), and only
 * the newest of each kind on an account is in the running: a list that still
 * offers Opus 4.7 next to Opus 5.5 means Opus 5.5. It keeps to the account of
 * the model the user chose (their Claude plan stays their Claude plan) and
 * goes to another only when that one has nothing big enough for the task, or
 * nothing that sees an image. Then a plan comes before a key that bills each
 * token, and a local or free model only when nothing else will do.
 *
 * Within a chat where the agent has already worked, Adaptive only moves up:
 * switching to a smaller model for a follow-up would start the conversation
 * over on it (its cache, and for Claude its session), which costs more than
 * the smaller model saves.
 */

export type TaskKind = RouteRecord['kind']
export type { RouteRecord }

/** What a message asks for, as Adaptive reads it. */
export interface Task {
  kind: TaskKind
  /** It has images, so the model has to see them. */
  vision: boolean
}

/** 1 fast, 2 all-rounder, 3 most capable. */
export type Tier = RouteRecord['tier']

/** What Adaptive chose for a message, kept on the reply to say so. */
export interface AdaptiveRoute {
  option: ModelOption
  kind: TaskKind
  effort: EffortLevel | undefined
  /** "Sonnet 5.5 · coding, medium effort", for the reply's footer. */
  reason: string
}

const TIER_FOR: Record<TaskKind, Tier> = { quick: 1, write: 2, code: 2, hard: 3 }
const EFFORT_FOR: Record<TaskKind, EffortLevel> = { quick: 'light', write: 'light', code: 'medium', hard: 'high' }
const KIND_LABEL: Record<TaskKind, string> = { quick: 'quick question', write: 'writing', code: 'coding', hard: 'hard problem' }

const CODE =
  /```|\b(function|class|const|import|def|return|async|await|interface)\b|[\w./-]+\.(tsx?|jsx?|mjs|cjs|py|rs|go|java|kt|swift|rb|php|cs|cpp|c|h|hpp|css|scss|html|vue|svelte|json|ya?ml|toml|sql|sh|gradle|lock)\b|\b(bugs?|fix(es|ed|ing)?|errors?|exceptions?|stack ?trace|crash(es|ed|ing)?|compile|builds?|tests?|lint|typecheck|refactor|implement|feature|component|endpoint|api|repo|commit|branch|merge|rebase|deploy|install|npm|pnpm|yarn|pip|git|docker|server|database|schema|migration|css|ui|frontend|backend|script|code|function|button|click(s|ed)?|page|screen|layout|style|form|modal|login|sign[- ]?in|app|website|site|game)\b/i
const HARD =
  /\b(architect(ure)?|redesign|rewrite|from scratch|end[- ]to[- ]end|whole (app|project|codebase|game|site)|entire (app|project|codebase|game|site)|across the (app|codebase|project)|race condition|deadlock|memory leak|performance|optimi[sz]e|security|vulnerab\w*|concurren\w*|root cause|investigate|figure out why|migrat\w*|scal(e|ing|able)|overhaul|rework (the|all|everything))\b|\b(build|make|create|develop)\s+(me\s+)?(a|an|the)\s+(\w+\s+){0,3}(app|game|website|site|platform|backend|extension|cli|tool|dashboard|engine|service)\b/i
const STACK = /\n\s+at\s+\S.*:\d+:\d+|Traceback \(most recent call last\)|^\s*File ".*", line \d+/m
const WRITE = /\b(write|draft|rewrite|proofread|summari[sz]e|translate|email|essay|blog|post|tweet|letter|story|poem|caption|cover letter|resume|cv|bio|announcement|newsletter|speech|outline)\b/i
const GO_ON = /^((continue|go on|keep going|carry on|yes|yeah|yep|ok(ay)?|do it|go ahead|proceed|sure|please( do)?|sounds good|lgtm|try again|retry)\b[\s,.!]*)+$/i

/**
 * What a message asks for. `previous` is the kind the chat's last routed reply
 * had, for "continue" and "yes": a go-ahead is more of the same work.
 */
export function classifyTask(text: string, context: { images: boolean; inProject: boolean; toolWork: boolean; previous: TaskKind | null }): Task {
  const t = text.trim()
  const words = t ? t.split(/\s+/).length : 0
  const vision = context.images
  if (GO_ON.test(t)) return { kind: context.previous ?? (context.toolWork ? 'code' : 'quick'), vision }
  const code = CODE.test(t)
  if (HARD.test(t) || STACK.test(t) || t.length > 1500 || (code && t.length > 700)) return { kind: 'hard', vision }
  if (code) return { kind: 'code', vision }
  if (WRITE.test(t) && words > 3) return { kind: 'write', vision }
  // A message about the project with nothing that says otherwise is most likely work on it.
  if (context.inProject && words > 6) return { kind: 'code', vision }
  return { kind: words > 60 ? 'write' : 'quick', vision }
}

const FAST = /\b(haiku|luna|mini|nano|flash|lite|small|tiny|instant|air|\d+(\.\d+)?b)\b|fast(est)?\b|quick answers|affordable|high volume|efficient model|easier tasks/i
const TOP = /\b(opus|fable|astra|ultra|pro|max|frontier|heavy|large)\b|most capable|toughest|hardest|most demanding/i
const OLD = /\b(older|previous generation|legacy|deprecated)\b/i
/** The very largest models: the user's plan runs out on them fastest, so they go only to someone who picked them. */
const HEAVY = /\b(fable|ultra|heavy)\b|longest-running/i
const CODER = /\b(code|codex|coder|coding|devstral|codestral|terra)\b/i

/** How capable a model is, from its name and what its provider says of it. */
export function tierOf(option: Pick<ModelOption, 'modelId' | 'label'> & { description?: string }): Tier {
  const name = `${option.modelId} ${option.label}`
  // The name first: Sonnet is "most efficient for simpler tasks" in Claude's own words, but it isn't a small model.
  if (/\b(haiku|luna|mini|nano|flash|lite)\b/i.test(name)) return 1
  if (/\b(opus|fable|astra)\b/i.test(name)) return 3
  if (/\b(sonnet|sol|terra)\b/i.test(name)) return 2
  const said = `${name} ${option.description ?? ''}`
  if (FAST.test(said)) return 1
  if (TOP.test(said)) return 3
  return 2
}

/** The version in a name ("gpt-6.1-sol" → 6.1, "claude-opus-4-8" → 4.8), for keeping the newest of a kind. */
export function versionOf(id: string): number {
  const dotted = /(\d+)\.(\d+)/.exec(id)
  if (dotted) return Number(`${dotted[1]}.${dotted[2]}`)
  const dashed = /-(\d)-(\d)(?:-|$)/.exec(id)
  if (dashed) return Number(`${dashed[1]}.${dashed[2]}`)
  const single = /(?:^|[-_ ])(\d{1,2})(?:[-_ ]|$)/.exec(id)
  return single ? Number(single[1]) : 0
}

/** The kind of model a name is, without its version: "claude-opus-4-8" and "Opus 5.5" are both "opus". */
function familyOf(option: ModelOption): string {
  const name = `${option.modelId} ${option.label}`.toLowerCase()
  const known = /\b(opus|sonnet|haiku|fable|sol|terra|luna|astra|mini|nano|flash|lite|pro|coder|codex)\b/.exec(name)
  return `${option.groupId}:${known ? known[1] : name.replace(/[\d.]+/g, '').replace(/[^a-z]+/g, '-')}`
}

interface Candidate {
  option: ModelOption
  tier: Tier
  version: number
  family: string
  plan: boolean
  local: boolean
  free: boolean
  coder: boolean
  old: boolean
  heavy: boolean
}

/** The models Adaptive may choose from: ready to run, able to use tools, and the newest of each kind on its account. */
export function candidates(options: ModelOption[], providers: Provider[]): Candidate[] {
  const byId = new Map(providers.map((p) => [p.id, p]))
  const usable = options.filter(
    (o) =>
      o.availability === 'ready' &&
      !o.planNote &&
      o.tools !== false &&
      o.stage !== 'deprecated' &&
      // A provider's or engine's own "Default" is one of its other models under another name.
      o.modelId !== '' &&
      o.modelId !== 'default' &&
      !/:batch$|embed|whisper|tts|image|dall-e|moderation|realtime|audio|transcribe/i.test(o.modelId)
  )
  const all: Candidate[] = usable.map((option) => {
    const provider = option.providerId ? byId.get(option.providerId) : undefined
    const description = option.model?.description ?? ''
    const text = `${option.modelId} ${option.label} ${description}`
    return {
      option,
      tier: tierOf({ ...option, description }),
      version: versionOf(option.modelId) || versionOf(option.label),
      family: familyOf(option),
      // An agent CLI runs on its own sign-in and plan, as a subscription provider does.
      plan: option.engine !== 'native' || provider?.category === 'subscription',
      local: Boolean(provider?.local),
      free: /\bfree\b/i.test(text) || provider?.category === 'eaon',
      coder: CODER.test(text),
      old: OLD.test(description),
      heavy: HEAVY.test(text)
    }
  })
  // The newest of each family on each account: Opus 5.5 rather than Opus 4.7 beside it.
  const newest = new Map<string, number>()
  for (const c of all) newest.set(c.family, Math.max(newest.get(c.family) ?? 0, c.version))
  return all.filter((c) => c.version >= (newest.get(c.family) ?? 0) && !(c.old && all.some((o) => o.family === c.family && !o.old)))
}

/** How well a model suits a task; higher is better. */
function fit(c: Candidate, task: Task): number {
  const want = TIER_FOR[task.kind]
  let score = 0
  // Too small for the task costs more than too big: a weak answer is redone, a strong one only costs more.
  score -= c.tier < want ? (want - c.tier) * 14 : (c.tier - want) * 6
  if (c.plan) score += 4
  if (c.local) score -= task.kind === 'quick' ? 6 : 20
  if (c.free) score -= task.kind === 'quick' ? 2 : 10
  if (c.old) score -= 4
  if (c.heavy) score -= 2
  if (c.coder && (task.kind === 'code' || task.kind === 'hard')) score += 1
  return score
}

/**
 * The model and effort for a message, or null when nothing fits (the chosen
 * model then runs as usual). `prefer` are the user's own picks (the model
 * selected before Adaptive, starred and recent ones), which break ties.
 */
export function pickModel(input: {
  task: Task
  options: ModelOption[]
  providers: Provider[]
  /** Where the chat's last routed reply ran, when the agent has worked in it: only a step up moves it. */
  stay?: RouteRecord | null
  prefer?: string[]
}): AdaptiveRoute | null {
  const { task } = input
  let pool = candidates(input.options, input.providers)
  if (task.vision) pool = pool.filter((c) => c.option.vision !== false)
  if (pool.length === 0) return null

  const here = input.stay ? pool.find((c) => c.option.key === input.stay!.key) : undefined
  // Staying put unless this task needs a bigger model than the one the chat is on; the effort is still this task's.
  if (here && here.tier >= TIER_FOR[task.kind]) return route(here.option, task.kind, task)

  const prefer = input.prefer ?? []
  const rank = (key: string): number => {
    const i = prefer.indexOf(key)
    return i === -1 ? 0 : 3 - Math.min(i, 2) * 0.5
  }
  // The account the user works on is where it stays: another plan or key is used only when theirs has
  // nothing big enough (or nothing that sees images). Then the user's own picks, then the newest model.
  const account = prefer[0]?.split(':').slice(0, -1).join(':') ?? null
  const score = (c: Candidate): number =>
    fit(c, task) + rank(c.option.key) + (account && (c.option.providerId === account || `engine:${c.option.engine}` === account) ? 10 : 0) + c.version * 0.01
  const best = pool.reduce((a, b) => (score(b) > score(a) ? b : a))
  return route(best.option, task.kind, task)
}

function route(option: ModelOption, kind: TaskKind, task: Task): AdaptiveRoute {
  const effort = clampEffort(EFFORT_FOR[kind], option.efforts)
  const what = task.vision ? `${KIND_LABEL[kind]} with images` : KIND_LABEL[kind]
  return { option, kind, effort, reason: effort ? `${what}, ${EFFORT_LABEL[effort].toLowerCase()} effort` : what }
}

/** What a reply keeps of its route. */
export function routeRecord(route: AdaptiveRoute): RouteRecord {
  return { key: route.option.key, label: route.option.label, kind: route.kind, tier: tierOf({ ...route.option, description: route.option.model?.description }), reason: route.reason }
}
