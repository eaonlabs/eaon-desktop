/** Types shared between the main and renderer processes. */

import type { WorkerMail } from './workers'
import type { ProviderHealth, ProviderIssue } from './providers'
import type { EngineId, ModelSource } from './engines'

/**
 * Wire format a provider speaks. `openai-responses` is OpenAI's Responses API
 * (also what ChatGPT/Codex subscriptions are served over); everything else that
 * is not Anthropic speaks chat-completions.
 */
export type ProviderKind = 'openai' | 'anthropic' | 'openai-compatible' | 'ollama' | 'openai-responses'

/** How a provider authenticates: a pasted key, a browser sign-in, or nothing (local runtimes). */
export type ProviderAuth = 'key' | 'oauth' | 'none'

export interface ModelInfo {
  id: string
  /** Short display name shown in the model picker, e.g. "5.6 Sol". */
  label: string
  providerId: string
  /** Reasoning-effort levels this model accepts, if any. */
  efforts?: EffortLevel[]
  contextWindow?: number
  /** Largest `max_tokens` the model accepts; used to size requests. */
  maxOutput?: number
  /** Capability badges shown next to the model name in the provider detail panel. */
  tools?: boolean
  vision?: boolean
  /** True for models that think before answering (reasoning / extended thinking). */
  reasoning?: boolean
  /** Added by hand in Settings → Model providers, rather than from the catalog or the provider's listing. */
  custom?: boolean
  /** The user changed its details (Edit model): its limits or capabilities, or its name. */
  edited?: boolean
  /**
   * Where this entry came from and when: the shipped catalog, the remote
   * catalog, the provider's own listing (live, or the last one that worked),
   * or the user. Unset for models from before sources were tracked.
   */
  source?: ModelSource
  /** Release stage, when a source says so (models.dev's status, the id itself saying "preview"). */
  stage?: 'preview' | 'deprecated'
  /**
   * The catalog knows it but the provider's own list for this account
   * doesn't include it (ChatGPT): it may not be on the user's plan. Offered,
   * marked, rather than hidden — a plan's list lags new models.
   */
  outsidePlan?: boolean
  /** Other ids the same model is served under (a dated snapshot of an alias), folded into this entry. */
  aliases?: string[]
  /**
   * Fields Eaon filled in from the model's id alone, because no source said.
   * They still shape requests (whether to ask for reasoning), but they are
   * guesses: pickers show no badge for them.
   */
  inferred?: ('reasoning' | 'efforts')[]
}

/**
 * Reasoning effort, lowest to highest. `light`, `extra-high` and `ultra` are
 * the old ids for low, xhigh and max — see `shared/effort.ts` for the labels
 * and wire names.
 */
export type EffortLevel = 'none' | 'minimal' | 'light' | 'medium' | 'high' | 'extra-high' | 'ultra'

export interface Provider {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  /** True once an API key has been stored for this provider. */
  hasKey: boolean
  enabled: boolean
  models: ModelInfo[]
  /** Providers we ship out of the box cannot be deleted, only disabled. */
  builtIn: boolean
  /** Local runtimes (llama.cpp, MLX, Ollama) are grouped separately and never require a key. */
  local: boolean
  /** How many fallback keys are configured, tried in order if the primary key fails. */
  fallbackCount: number
  /** Defaults to 'key' for remote providers and 'none' for local runtimes. */
  auth?: ProviderAuth
  /** Id of the OAuth flow in `main/providers/oauth`, when `auth` is 'oauth'. */
  oauthFlow?: string
  /** True once an OAuth sign-in has completed and its tokens are stored. */
  signedIn?: boolean
  /** Grouping in the providers list. */
  category?: 'eaon' | 'local' | 'subscription' | 'frontier' | 'gateway' | 'inference' | 'regional' | 'custom'
  /** One line shown under the provider name. */
  description?: string
  /** Where to create an API key for this provider. */
  keyUrl?: string
  /** Extra headers every request to this provider carries (OpenRouter attribution, etc.). */
  headers?: Record<string, string>
  /** Models the user removed from this provider's list; kept so they can be restored. */
  hiddenModels?: ModelInfo[]
  /**
   * What the last check of this provider's credentials found. A failed check
   * (an expired sign-in, a rejected key) makes it "Needs attention" even
   * though credentials are stored; a later success clears it.
   */
  health?: ProviderHealth
  /** When the provider's own model listing last worked, or null if it never has. */
  modelsListedAt?: number | null
}

export interface ChatTextPart {
  type: 'text' | 'reasoning'
  text: string
}

/**
 * One tool call and its result, kept in the transcript rather than only in the
 * agent loop's local scratch array.
 *
 * Without this the next turn cannot see that the previous one edited a file or
 * that a test failed — history was rebuilt from text parts alone, so every tool
 * call the agent made vanished the moment the turn ended. Stored in a
 * provider-neutral shape rather than as raw Anthropic/OpenAI blocks so a chat
 * survives switching models mid-conversation, and so the transcript UI has the
 * arguments and output it needs to render the call.
 */
export interface ChatToolPart {
  type: 'tool'
  /** Provider-assigned call id, needed to pair results back up on replay. */
  id: string
  name: string
  input: Record<string, unknown>
  /** Null while the tool is still running. */
  output: string | null
  status: 'running' | 'done' | 'denied' | 'error'
  /**
   * Images the tool returned (screenshots), as absolute paths under the app's
   * attachments folder. Kept on disk rather than inline so chats.json stays
   * small; only the newest one is ever replayed to the model.
   */
  images?: string[]
  /** Live output while a long command is still running, replaced by `output` when it ends. */
  progress?: string
  /** Sub-agents a swarm call started, in the order they were launched. */
  agents?: SubagentRun[]
}

/** One sub-agent inside a swarm tool call. */
export interface SubagentRun {
  index: number
  role: string
  task: string
  status: 'queued' | 'running' | 'done' | 'error'
  /** Final text the sub-agent reported back. */
  output?: string
  toolCalls: number
  /** The step the sub-agent is on right now, e.g. "Read src/main/store.ts". */
  activity?: string
}

/** Token accounting for one assistant turn, summed across its tool rounds. */
export interface TokenUsage {
  input: number
  output: number
  /** Input tokens served from the provider's prompt cache. */
  cacheRead: number
  /** Input tokens written to the prompt cache this turn. */
  cacheWrite: number
}

/** A plan the agent proposed in plan mode, waiting for the user's go-ahead. */
export interface PlanProposal {
  title: string
  summary: string
  steps: string[]
  status: 'pending' | 'approved' | 'revising'
}

/** The agent's own running checklist (`update_plan`), shown pinned above the composer. */
export interface TodoItem {
  text: string
  status: 'pending' | 'in_progress' | 'done'
}

/** A long-running objective the agent keeps pursuing across rounds (goal mode). */
export interface GoalState {
  text: string
  status: 'active' | 'achieved' | 'blocked' | 'paused'
  /** How many times the agent has been sent back to keep working on it. */
  iterations: number
  /** Set when the agent reports the goal achieved or blocked. */
  summary?: string
  /**
   * Work on it until this time (a timestamp), instead of stopping after the
   * usual number of continuations or minutes. Unset for an ordinary goal.
   */
  until?: number | null
}

export type ChatMessagePart = ChatTextPart | ChatToolPart

/** What the user said about a reply: a thumb and one emoji, either or both. */
export interface MessageFeedback {
  vote?: 'up' | 'down' | null
  reaction?: string | null
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  parts: ChatMessagePart[]
  createdAt: number
  /** When the turn finished, for the "Worked for 1m 22s" line. Absent on older chats and unfinished turns. */
  finishedAt?: number
  /**
   * Set on a reply while it is only a checkpoint of one still being written.
   * The final save removes it; if it is still there when the chat loads, Eaon
   * quit or crashed before the reply finished.
   */
  interrupted?: boolean
  /** Set when a request failed so the UI can show an inline error. */
  error?: string
  /** What kind of provider failure `error` is, with the fix to offer (Reconnect, Add a key…). */
  errorIssue?: ProviderIssue
  model?: string
  /** Tokens this turn spent, including cache reads and writes. */
  usage?: TokenUsage
  /** Plan proposed in this turn (plan mode). */
  plan?: PlanProposal
  /** Latest checklist the agent published during this turn. */
  todos?: TodoItem[]
  /** Files the user attached to this message, as absolute paths. */
  attachments?: string[]
  /** The user's thumbs and emoji on a reply, from its action bar. */
  feedback?: MessageFeedback
  /** Set on messages a scheduled task produced, so the UI can label them. */
  scheduledTaskId?: string
  /**
   * Workers: the mail this turn was woken by, one entry per sender. The model
   * reads the combined text in `parts`; the transcript shows each piece of
   * mail as its own bubble, with the sender's face.
   */
  mail?: WorkerMail[]
  /** Workers: set when a scheduled heartbeat woke this turn — the worker's own note. */
  heartbeat?: string
}

export interface Chat {
  id: string
  workspaceId: string
  projectId: string | null
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  archived: boolean
  pinned: boolean
  unread: boolean
  modelId: string | null
  effort: EffortLevel
  /** Goal mode: the objective this chat keeps working toward. */
  goal?: GoalState | null
  /**
   * Compaction: a summary standing in for every message up to and including
   * `throughMessageId`, so a long chat stops resending its whole history.
   */
  summary?: { text: string; throughMessageId: string } | null
}

export interface Project {
  id: string
  workspaceId: string
  name: string
  instructions: string
  createdAt: number
}

export interface Workspace {
  id: string
  name: string
  /**
   * The top-bar modes. 'chat' is the assistant — an agent that can use files,
   * the shell, the browser and plugins behind a simple composer. 'workers' is
   * the team of always-on agents (`shared/workers.ts`), and 'code' is the ADE,
   * the Eaon Code session UI.
   *
   * 'work' was the separate agent tab before Chat absorbed it; it no longer
   * appears in a migrated install but stays in the union so old data parses.
   */
  kind: 'chat' | 'work' | 'code' | 'workers'
  /** Folder the chat agent runs commands and file edits in. Null until chosen (~/Eaon). */
  cwd?: string | null
}

export type ThemeMode = 'system' | 'light' | 'dark'
/**
 * The icon Eaon shows in the Dock (macOS) or on its windows and taskbar button
 * (Windows, Linux): the Disc E, the agent face on the same tile, or the Disc E
 * on another background (scripts/make-icon.py, VARIANTS). The Finder and the
 * installer always show the Disc E; see main/appIcon.ts.
 */
export type AppIcon = 'default' | 'agent' | AppIconBackground
/** The Disc E on another background than the default dark tile. */
export type AppIconBackground = 'light' | 'ocean' | 'sunset' | 'forest' | 'grape' | 'aurora' | 'peaks'
export const APP_ICON_BACKGROUNDS: readonly AppIconBackground[] = ['light', 'ocean', 'sunset', 'forest', 'grape', 'aurora', 'peaks']
export type LaunchMode = 'chat' | 'workers' | 'ade' | 'last'
/**
 * How the chat agent asks before acting. `ask`: before every change. `auto`:
 * only before risky ones. `full`: never, except for what can't be undone —
 * sudo, erasing disks, force-pushing, credentials, passwords and payments
 * (a tool's `catastrophic`) still wait for the user.
 */
export type ApprovalMode = 'ask' | 'auto' | 'full'

export interface ThemePalette {
  preset: string
  accent: string
  background: string
  foreground: string
  fontFamily: string
  fontWeight: string
  translucentSidebar: boolean
  contrast: number
}

/** How the wallpaper is drawn: as it is, as a halftone dot screen, or as ASCII art. */
export type SeeThroughStyle = 'photo' | 'halftone' | 'ascii'

export interface SeeThrough {
  enabled: boolean
  tint: number
  /** The halftone switch from before `style`; still read when `style` is unset, and kept in step with it. */
  texture: boolean
  /** Unset on installs from before it, which follow `texture` instead. */
  style?: SeeThroughStyle
  /** The desktop's own wallpaper, or a picture the user chose. */
  source: 'desktop' | 'custom'
  /** The chosen picture, as Eaon's own copy of it (see main/features/wallpaper.ts). */
  custom: string | null
}

/** What the window needs to draw the wallpaper behind it: the image, and where the screen and the window are. */
export interface WallpaperFrame {
  /** The display the window is on: its id, and its bounds in screen points. */
  display: { id: number; x: number; y: number; width: number; height: number }
  /** The window's content area, in screen points. */
  content: { x: number; y: number; width: number; height: number }
}

export interface Settings {
  general: {
    defaultPermissions: boolean
    fullAccess: boolean
    fileOpenDestination: string
    language: string
    showInMenuBar: boolean
    bottomPanel: boolean
    preventSleep: boolean
    suggestedPrompts: boolean
    launchAtLogin: boolean
    /** Which mode the app opens in: a fixed one, or wherever it was left. */
    launchMode: LaunchMode
  }
  appearance: {
    mode: ThemeMode
    light: ThemePalette
    dark: ThemePalette
    pointerCursors: boolean
    reduceMotion: 'system' | 'on' | 'off'
    fontSize: number
    fontSmoothing: boolean
    appIcon: AppIcon
    /**
     * See-through: the desktop's wallpaper drawn behind the app, lined up
     * with the screen, so the window reads as glass over the desktop.
     * `tint` (0–100) is how much of the theme's colour lies over it, and
     * `style` draws it as it is, as a halftone screen or as ASCII art.
     */
    seeThrough: SeeThrough
  }
  configuration: {
    configScope: string
    approvalPolicy: string
    sandbox: string
    webSearch: string
    outputDetail: string
    reasoningSummary: string
    workspaceDependencies: boolean
  }
  browser: {
    /** Opened in each new tab of the built-in browser; empty for a blank tab. */
    homepage: string
    /** What the address bar searches with: 'DuckDuckGo' (default), 'Google' or 'Bing'. */
    searchEngine?: string
    /** Unused: the "Import from Chrome" banner imported nothing and was removed in 2026.6.2. */
    importedFromChrome: boolean
    /** Unused since 2026.6.2, with the banner. */
    dismissedImportBanner: boolean
  }
  mcp: {
    allowAllToolPermissions: boolean
    toolCallTimeoutSeconds: number
    smartRouting: boolean
    useDedicatedRoutingModel: boolean
    routingModelId: string | null
  }
  localServer: {
    autoStart: boolean
    port: number
    /**
     * The model a request gets when it names one Eaon doesn't have (Claude
     * Code's and Codex's own model names, say). `provider/model` or a bare id.
     */
    defaultModelId: string | null
    /** The same, for the fast slot: a requested model that looks small (haiku, mini). Falls back to the default. */
    smallModelId: string | null
    /** This install's key for the server, made on first use; apps connected to Eaon send it. */
    token: string | null
    /** Refuse requests that send no key, from apps as well as browser pages. */
    requireKey: boolean
  }
  /**
   * Remote devices (docs/remote-api.md): a phone on the user's network
   * controlling Workers. Off by default; unlike the Local API Server it
   * listens on every interface, and always wants its own key.
   */
  remote: {
    enabled: boolean
    port: number
    /** `eaonr-…`, made the first time it is turned on and replaced by Reset key. */
    token: string | null
    /**
     * Let a phone create a worker with full autonomy, or raise one to it.
     * Off by default: remote traffic crosses the local network.
     */
    allowAutonomous: boolean
  }
  /**
   * Eaon Remote (rc.eaon.dev): this computer linked to a GitHub account, so
   * its ADE sessions and Workers can be used from a browser anywhere. The
   * device token is in the secrets vault, never here.
   */
  rc: {
    /** Connected to the relay (when linked). */
    enabled: boolean
    deviceId: string | null
    /** The GitHub account it is linked to. */
    login: string | null
    avatar: string | null
  }
  /** The ADE's usage meter for Claude Code and Codex plans (Settings → Accounts). */
  /** Settings → Usage & limits. */
  usageLimits: {
    /** The providers the sidebar's rings show, in order, at most two. */
    sidebar: string[]
    /** Both limits as two rings, or one ring for the 5-hour or the weekly limit. */
    ring: 'both' | '5h' | 'weekly'
    /** A ring's card opens with its details (balances, token totals) showing. */
    details: boolean
    /** Codex's banked resets in the details. */
    banked: boolean
    /** Credit balances and recent token totals in the details. */
    tokens: boolean
  }
  /** Settings → Agent providers. */
  agentProviders: {
    /** Coding CLIs left out of the ADE's "New terminal" picker. */
    hidden: string[]
    /** The picker's order, by agent id; ones not listed follow in their own order. */
    order: string[]
    /** Start agents' terminals at a lower CPU priority, so the computer stays quick while they work. */
    lowPriority: boolean
    /** Look for newer versions of installed CLIs in the background. */
    updateChecks: boolean
  }
  /** Settings → Profile: how the activity profile and its share card name you. */
  profile: {
    name: string
    handle: string
    color: string
  }
  cliUsage: {
    /** Show the plan usage meter at all. */
    meter: boolean
    /** How its panel lays the figures out. */
    view: 'detailed' | 'compact'
    /** A system notification when the active account nears (90%) or hits a limit. */
    alerts: boolean
    /** Move new Codex sessions, and Eaon's Codex engine, to another signed-in account when the active one hits its limit. */
    autoSwitchCodex: boolean
    /** Where it sits: the sidebar's foot, the ADE's header, or both. */
    placement: 'sidebar' | 'header' | 'both'
    /** What it looks like: a ring per CLI, or a bar with the figures. */
    style: 'rings' | 'bar'
  }
  /** Settings → Usage. */
  /** The ADE's terminals: their theme (`/theme` in a pane, or the header's Theme button). */
  ade: {
    /** A terminal theme id (components/code/terminal/themes.ts); `eaon` follows the app. */
    theme: string
    /** Draw the theme's scene behind the terminal text. */
    scenes: boolean
    /** Soften the scene behind the text with a blur, `blurAmount` px strong. */
    blur: boolean
    blurAmount: number
    /**
     * The app's own appearance from before a terminal theme restyled it (the
     * app follows the terminal theme), put back when `eaon` is picked again.
     */
    appBefore: { mode: ThemeMode; light: ThemePalette; dark: ThemePalette } | null
    /** Hold a key to dictate into the terminal last typed in (code/terminal/AdeDictation.tsx). */
    dictation: {
      enabled: boolean
      /** The key held to talk, as a `KeyboardEvent.code` (shared/holdKey.ts). */
      key: string
      /** The speech-to-text model for the ADE; both null uses the one picked under Settings → Model providers → Speech to text. */
      speechProviderId: string | null
      speechModelId: string | null
    }
  }
  /** The popup that asks whether to star Eaon on GitHub (main/starPrompt.ts). */
  starPrompt: {
    /** `pending` until they star it or say no thanks. */
    status: 'pending' | 'starred' | 'declined'
    /** How many times Eaon has been opened. It asks from the third. */
    launches: number
    /** How many times the popup has been shown, at most three. */
    asked: number
    lastAskedAt: number | null
  }
  /**
   * First run (components/onboarding): the setup, then the tour of the app.
   * A fresh install starts both `pending`; an install from before they
   * existed starts them `done` (main/features/onboarding.ts).
   */
  onboarding: {
    setup: 'pending' | 'done' | 'skipped'
    tour: 'pending' | 'done' | 'skipped'
    /** When the setup was finished or skipped. */
    finishedAt: number | null
  }
  /** The tokn command, which ships inside Eaon (main/features/toknCli.ts). */
  toknCli: {
    /** Put `tokn` on PATH. On by default: it comes with Eaon. */
    install: boolean
    /**
     * Link it to the Tokn account Eaon is signed in with, and publish what it
     * finds (Claude Code, Codex and the other CLIs' usage) every hour. Asked
     * in the setup; off until the person says yes.
     */
    sync: boolean
  }
  /** Eaon Free: the free models on Eaon's gateway, and the card that offers them (shared/freeCredits.ts). */
  freeCredits: {
    /** Claimed from the offer or Settings → Model providers: the provider is listed and usable. */
    claimed: boolean
    claimedAt: number | null
    /** How many times the offer card has been shown, at most three. */
    offered: number
    lastOfferedAt: number | null
  }
  /** Settings → General → Software update. */
  updates: {
    /**
     * Tell me when a beta is out, with its own button to download it. Off by
     * default: betas are early builds. Stable updates are not affected.
     */
    beta: boolean
  }
  claudeCode: {
    largeModelId: string | null
    mediumModelId: string | null
    smallModelId: string | null
    env: { id: string; key: string; value: string }[]
    enabled: boolean
  }
  /** Dictation: the speech-to-text model (see shared/speech.ts). Both null picks automatically. */
  voice: {
    speechProviderId: string | null
    speechModelId: string | null
  }
  codeIndex: {
    /** Provider used for embeddings; null means keyword-only search. */
    embeddingProviderId: string | null
    embeddingModelId: string | null
    /** Re-index the project folder automatically when Eaon Work opens it. */
    autoIndex: boolean
    /** Ceiling on agent tool round-trips per turn — agentic coding needs many. */
    maxToolRounds: number
  }
  shortcuts: Record<string, string | null>
  /** Ids of plugins the user has installed from the directory. */
  installedPlugins: string[]
  disabledPlugins: string[]
  disabledSkills: string[]
  activeWorkspaceId: string
  selectedModelId: string | null
  /**
   * Which provider serves the selected model. The id alone is ambiguous once a
   * ChatGPT sign-in, Copilot and an OpenAI key all offer the same model.
   */
  selectedProviderId: string | null
  /**
   * Set when Chat's model is an agent engine's (a Codex model) rather than a
   * provider's; `selectedEngineModel` is then that engine's model ('' for its
   * default). Picking a provider model clears it.
   */
  selectedEngine?: Exclude<EngineId, 'native'> | null
  selectedEngineModel?: string | null
  /** Starred models, as `providerId:modelId`; they head the model menu. */
  favoriteModels: string[]
  /** Models picked lately, newest first, as `providerId:modelId`. */
  recentModels?: string[]
  effort: EffortLevel
  approvalMode: ApprovalMode
  /** Plan mode (Work): read-only research, then a plan the user approves before anything changes. */
  planMode: boolean
  work: {
    /** Swarm mode: the agent may split work across parallel sub-agents. */
    swarm: boolean
    /** How many times goal mode may send the agent back to keep working before it stops and reports. */
    goalMaxIterations: number
    /** Goal mode pauses once one reply has run this long, in minutes. 0 = no limit. */
    goalMaxMinutes: number
    /** Goal mode pauses once one reply has used this many tokens (input + output). 0 = no limit. */
    goalMaxTokens: number
    /** Model sub-agents run on; null means the chat's own model. */
    subagentModelId: string | null
    /** Folder Work mode acts in when no project folder has been chosen; null means ~/Eaon. */
    defaultFolder: string | null
  }
  /** Token-saving behaviour shared by Chat and Work. */
  context: {
    /** Summarise older turns once a chat nears the model's context window. */
    autoCompact: boolean
    /** Fraction of the context window (0–1) at which compaction kicks in. */
    compactAt: number
    /** Tool output from turns older than this many user messages is trimmed before it is resent. */
    keepFullToolTurns: number
  }
  computerUse: {
    enabled: boolean
    /** Ask before every click and keystroke, even in "Approve for me". */
    confirmEachAction: boolean
    /** Sharper screenshots cost more tokens per step. */
    quality: 'balanced' | 'sharp'
  }
  /** The agent in the user's own browser, through Browser Use (main/features/browserUse.ts). */
  browserUse: {
    enabled: boolean
    /** Which browser (chromium.ts ids); null: whichever allows remote debugging. */
    browser: string | null
  }
  /** Discord Rich Presence — see main/features/discordPresence.ts. */
  discord: {
    /** Show "Playing Eaon Desktop" on the user's Discord profile while the window is open. */
    enabled: boolean
    /** What Eaon is doing (thinking, running tools, away) and which tab is open. Never chat contents. */
    showStatus: boolean
    showElapsed: boolean
    /** The "Get Eaon Desktop" button linking to eaon.dev. */
    showButton: boolean
  }
  eaonCode: {
    /** Explicit path to the eaon-code binary; null means find it on PATH. */
    binaryPath: string | null
    /** Folder the Code tab last opened. */
    lastCwd: string | null
    /** Hand the API keys saved in Eaon to the ADE's Eaon Code terminals as environment variables. */
    shareKeys: boolean
  }
  notifications: {
    /** System notification when a Work task or scheduled run finishes while the window is in the background. */
    taskComplete: boolean
  }
  /**
   * Keep Eaon running without a window so scheduled tasks fire: start at
   * login, and on Windows stay in the notification area when the window
   * closes. See main/background.ts.
   */
  background: {
    enabled: boolean
  }
}

export interface McpServer {
  id: string
  name: string
  /** STDIO spawns a local process; HTTP connects to a streamable HTTP endpoint. */
  transport: 'stdio' | 'http'
  command: string
  args: string[]
  env: Record<string, string>
  /** Used when transport is 'http'. */
  url: string
  enabled: boolean
  /** Bundled servers we ship, shown with an "Official" badge. */
  official: boolean
  /**
   * Set when this server came from the built-in plugin catalog rather than
   * being added by hand. Holds the catalog entry's id, which is also the key
   * its token is stored under in the encrypted vault — the token itself is
   * never kept here, since this file is written to disk in the clear.
   */
  pluginId?: string
}

export interface McpTool {
  name: string
  description: string
  serverId: string
  inputSchema: Record<string, unknown>
  /** MCP tool annotations: whether the tool only reads, or can destroy data. */
  readOnly?: boolean
  destructive?: boolean
}

export interface McpServerStatus {
  serverId: string
  /** `needs-auth`: the server wants a browser sign-in (none yet, or it expired and could not be refreshed). */
  state: 'stopped' | 'starting' | 'ready' | 'error' | 'needs-auth'
  toolCount: number
  error?: string
}

export interface Skill {
  id: string
  name: string
  description: string
  source: 'personal' | 'system'
  enabled: boolean
}

export type AgentMode = 'chat' | 'work'

/** Per-turn Work options, read from the composer when the turn starts. */
export interface WorkOptions {
  swarm: boolean
  plan: boolean
}

export interface StreamRequest {
  chatId: string
  /** For the "Task finished" notification, so main need not read every chat to find it. */
  chatTitle?: string
  messageId: string
  providerId: string
  modelId: string
  effort: EffortLevel
  /** Chat gets web search only; Work gets the full agent. */
  mode: AgentMode
  /**
   * The conversation before this turn, oldest first, in its stored shape.
   * The main process decides what of it to resend — old tool output is
   * trimmed and older screenshots dropped there, not here.
   */
  history: ChatMessage[]
  /** Compaction summary standing in for every message before `history`. */
  summary: string | null
  /** The project's own instructions, appended to the system prompt. */
  projectInstructions: string
  /** Project folder Work mode acts in. Null uses the default Work folder. */
  cwd: string | null
  work: WorkOptions
  /** Goal mode objective for this chat, if one is active. */
  goal: GoalState | null
  /**
   * Replaces the built system prompt and turns every tool off — used by the
   * Local API Server, which proxies other apps' requests verbatim.
   */
  rawSystem?: string
  /** Set on a worker's turn: which worker is running, for the worker tools. */
  workerId?: string
  /** Set on a worker's turn in a thread other than its main one, so its tools act on that thread. */
  workerThreadId?: string
  /** Replaces the agent's opening identity line in the system prompt (a worker's persona). */
  persona?: string
  /**
   * Run the turn on this agent engine instead of Eaon's own loop: Chat with a
   * Codex model picked. `modelId` is then the engine's model ('' for its
   * default) and `providerId` is ignored.
   */
  engine?: EngineId
}

export type StreamEvent =
  | { type: 'delta'; messageId: string; text: string }
  | { type: 'reasoning'; messageId: string; text: string }
  | { type: 'done'; messageId: string }
  | { type: 'error'; messageId: string; error: string; issue?: ProviderIssue }
  | {
      type: 'approval-request'
      messageId: string
      requestId: string
      tool: string
      input: Record<string, unknown>
      /** The tool's own one-line description of this call, e.g. `click [2] button "Place order"`. */
      summary?: string
      /**
       * Asked whatever the approval mode, because it can't be undone (sudo, a
       * wiped disk, a payment). Switching to full access releases the other
       * waiting approvals, never these.
       */
      critical?: boolean
    }
  // A tool started and finished, as two events, so the transcript can show the
  // call the moment it is made rather than only once its output lands — a
  // `run_command` can take two minutes.
  | { type: 'tool-call'; messageId: string; toolId: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool-result'
      messageId: string
      toolId: string
      output: string
      status: 'done' | 'denied' | 'error'
      images?: string[]
    }
  // Live output from a tool that is still running (a build, a test run).
  | { type: 'tool-progress'; messageId: string; toolId: string; output: string }
  | { type: 'subagent'; messageId: string; toolId: string; run: SubagentRun }
  | { type: 'usage'; messageId: string; usage: TokenUsage }
  | { type: 'plan'; messageId: string; plan: PlanProposal }
  | { type: 'todos'; messageId: string; todos: TodoItem[] }
  | { type: 'goal'; messageId: string; chatId: string; goal: GoalState }
  | { type: 'compacted'; messageId: string; chatId: string; summary: string; throughMessageId: string }

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

export interface LocalServerStatus {
  running: boolean
  port: number
  /** Populated only while running, e.g. http://127.0.0.1:1337 */
  url: string | null
  error?: string
}

/** One chunk returned by the code index, with the code it came from. */
export interface SearchHit {
  path: string
  startLine: number
  endLine: number
  symbols: string[]
  text: string
}

export interface IndexStatus {
  state: 'idle' | 'indexing' | 'ready' | 'error'
  files: number
  chunks: number
  /** True when vectors exist; false means search falls back to keywords. */
  embedded: boolean
  /** Human-readable step shown while indexing, e.g. "Embedding 300/1200". */
  phase?: string
  updatedAt?: number
  /** Set when the project exceeded the chunk ceiling and was only partly indexed. */
  truncated?: boolean
  error?: string
}

export interface PullRequestSummary {
  id: string
  title: string
  repo: string
  branch: string
  url: string
  updatedAt: string
  additions: number
  deletions: number
  state: 'open' | 'closed' | 'merged' | 'draft'
}

export interface PullRequestsResult {
  authored: PullRequestSummary[]
  reviewing: PullRequestSummary[]
  /** Set when the `gh` CLI is missing or unauthenticated; lists are empty in that case. */
  error: string | null
}

export interface SystemInfo {
  os: { name: string; version: string }
  cpu: { model: string; architecture: string; cores: number; usagePercent: number }
  memory: { totalBytes: number; availableBytes: number; usagePercent: number }
}

/** A single downloadable GGUF file within a Hugging Face model repo. */
export interface ModelVariant {
  filename: string
  /** Quantization label parsed from the filename, e.g. "Q4_K_M". */
  quant: string
  sizeBytes: number
  /** Whether this file comfortably fits in the machine's total memory. */
  fits: boolean
}

export interface ModelSearchResult {
  /** Hugging Face repo id, e.g. "janhq/Jan-v3.5-4B-Gguf". */
  repoId: string
  name: string
  author: string
  downloads: number
  description: string
  tags: string[]
  capabilities: ('tools' | 'multimodal')[]
  fileCount: number
  /** The variant shown on the card itself — Q4_K_M when available, else the first file. */
  defaultVariant: ModelVariant | null
}

export interface ModelDetail {
  repoId: string
  name: string
  author: string
  downloads: number
  description: string
  parameterSize: string | null
  variants: ModelVariant[]
}

/**
 * A model file on this computer, run by Eaon's own llama.cpp runtime
 * (`main/llama/`). Downloaded from the curated library or from Browse Hugging
 * Face; kept in `downloaded-models.json`.
 */
export interface DownloadedModel {
  repoId: string
  /** The model's GGUF (the first shard of a split model). */
  filename: string
  quant: string
  /** Everything downloaded for it, vision projector included. */
  sizeBytes: number
  path: string
  downloadedAt: number
  /** The vision projector downloaded with it, for models that see images. */
  mmprojFilename?: string
  mmprojPath?: string
  /** Set when it came from the curated library: which entry and variant. */
  library?: { modelId: string; variantId: string }
  /** How the model picker names it ("MiniCPM5 2B · Q4_K_M"). */
  label?: string
  /** From the library entry: tools, vision, reasoning, coding, embedding. */
  capabilities?: string[]
  contextLength?: number
  /** From the Ollama era; ignored. */
  ollamaName?: string | null
  ollamaError?: string | null
}

export interface ModelDownloadProgress {
  repoId: string
  filename: string
  receivedBytes: number
  totalBytes: number
  phase: 'downloading' | 'registering'
}

/** One pull request in full, for the Pull requests page's detail tabs (main/github.ts). */
export interface PullRequestDetail {
  url: string
  number: number
  title: string
  body: string
  repo: string
  author: string
  state: 'open' | 'closed' | 'merged' | 'draft'
  base: string
  head: string
  additions: number
  deletions: number
  changedFiles: number
  createdAt: string
  updatedAt: string
  /** MERGEABLE, CONFLICTING or UNKNOWN (GitHub still working it out). */
  mergeable: string
  /** CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT, UNKNOWN. */
  mergeState: string
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or ''. */
  reviewDecision: string
  reviews: { author: string; state: string }[]
  checks: { name: string; status: 'passed' | 'failed' | 'pending' | 'skipped'; url: string | null }[]
  /** What the repository allows. */
  methods: { squash: boolean; merge: boolean; rebase: boolean }
  /** The repository deletes merged branches itself. */
  deletesBranch: boolean
}

export type PullRequestAction = { ok: true; message: string } | { ok: false; error: string }
