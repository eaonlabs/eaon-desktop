import { join } from 'node:path'
import type { ConnectChoice } from '@shared/connectApps'
import { deletePath, getPath, readJson, writeJson, writeJsonBack, type Json } from '../files'
import { exists, jsonMatches, listed, modelLabel, ownJsonKeys, releaseJsonKeys, type ConnectContext, type Connector } from '../connector'
import type { AppRecord } from '../state'

/**
 * Apps whose settings are a JSON file Eaon can merge into: Claude Code,
 * OpenCode, OpenClaw, Pi, Droid and Qwen Code. Formats checked against each
 * app's docs on Oct 3 2026 (links in the brain note on Connect apps).
 */

const small = (choice: ConnectChoice): string => choice.smallModel || choice.model

/** Every model the app should list: the picked ones, default first, and the fast one. */
const withSmall = (choice: ConnectChoice): string[] => [...new Set([...listed(choice), small(choice)])]

/** Connected when the file holds Eaon's address and key; stale when it holds an older one. */
function inspectBy(ctx: ConnectContext, file: string, record: AppRecord | null, current: [string[], unknown][]): { connected: boolean; stale: boolean } {
  if (jsonMatches(ctx, file, current)) return { connected: true, stale: false }
  const wrote = record?.keys[file]
  if (!wrote) return { connected: false, stale: false }
  const still = jsonMatches(
    ctx,
    file,
    wrote.filter((r) => current.some(([path]) => path.join('.') === r.path.join('.'))).map((r) => [r.path, r.wrote])
  )
  return { connected: still, stale: still }
}

/* ------------------------------------------------------------------ Claude Code */

const claudeFile = (ctx: ConnectContext): string => join(ctx.home, '.claude', 'settings.json')

/**
 * Claude Code reads `env` from ~/.claude/settings.json for every session.
 * ANTHROPIC_AUTH_TOKEN goes out as `Authorization: Bearer`; ANTHROPIC_API_KEY
 * is set empty so a key in the user's shell can't take over; the opus and
 * sonnet aliases follow the main model and haiku (background work) the small
 * one; model discovery fills /model from the gateway's model list.
 */
export const claudeCode: Connector = {
  id: 'claude-code',
  name: 'Claude Code',
  kind: 'config',
  blurb: 'Use your Eaon models in Claude Code.',
  hasSmallModel: true,
  installHint: 'npm install -g @anthropic-ai/claude-code',
  note: 'Start a new Claude Code session to pick it up. Your Claude sign-in stays as it is and comes back when you disconnect.',
  files: (ctx) => [claudeFile(ctx)],
  installed: (ctx) => Boolean(ctx.which('claude')) || exists(join(ctx.home, '.claude')),
  inspect: (ctx, record) => {
    const found = inspectBy(ctx, claudeFile(ctx), record, [
      [['env', 'ANTHROPIC_BASE_URL'], ctx.info.anthropicBaseUrl],
      [['env', 'ANTHROPIC_AUTH_TOKEN'], ctx.info.token]
    ])
    return found.connected ? found : { connected: hasLegacy(ctx), stale: hasLegacy(ctx) }
  },
  connect: (ctx, choice, previous) => {
    const file = claudeFile(ctx)
    // The old page's keys are Eaon's own: drop them first, so disconnecting doesn't put them back.
    if (!previous) dropLegacy(ctx)
    const { records, written } = ownJsonKeys(
      ctx,
      file,
      [
        [['env', 'ANTHROPIC_BASE_URL'], ctx.info.anthropicBaseUrl],
        [['env', 'ANTHROPIC_AUTH_TOKEN'], ctx.info.token],
        [['env', 'ANTHROPIC_API_KEY'], ''],
        [['env', 'ANTHROPIC_MODEL'], choice.model],
        [['env', 'ANTHROPIC_DEFAULT_OPUS_MODEL'], choice.model],
        [['env', 'ANTHROPIC_DEFAULT_SONNET_MODEL'], choice.model],
        [['env', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'], small(choice)],
        [['env', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'], '1']
      ],
      previous?.keys[file]
    )
    return { record: record(choice, { [file]: records }), written: [written] }
  },
  disconnect: (ctx, rec) => {
    releaseJsonKeys(ctx, claudeFile(ctx), rec.keys[claudeFile(ctx)])
    dropLegacy(ctx)
  },
  launch: () => ({ env: {}, command: 'claude' }),
  manual: (ctx, choice) =>
    [
      `Add to the "env" block of ~/.claude/settings.json:`,
      JSON.stringify(
        {
          ANTHROPIC_BASE_URL: ctx.info.anthropicBaseUrl,
          ANTHROPIC_AUTH_TOKEN: ctx.info.token,
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_MODEL: choice.model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: choice.model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: choice.model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: small(choice),
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1'
        },
        null,
        2
      )
    ].join('\n')
}

/**
 * Eaon's earlier Claude Code page wrote these into `env` with the fixed token
 * `eaon-local` and kept no record of what was there before. They are
 * recognised by that token and a local address.
 */
const LEGACY_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']

function hasLegacy(ctx: ConnectContext): boolean {
  try {
    const env = readJson(claudeFile(ctx), ctx.home).env as Json | undefined
    return env?.ANTHROPIC_AUTH_TOKEN === 'eaon-local' && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(String(env.ANTHROPIC_BASE_URL ?? ''))
  } catch {
    return false
  }
}

function dropLegacy(ctx: ConnectContext): void {
  if (!hasLegacy(ctx)) return
  const data = readJson(claudeFile(ctx), ctx.home)
  for (const key of LEGACY_KEYS) deletePath(data, ['env', key])
  writeJson(claudeFile(ctx), data)
}

function record(choice: ConnectChoice, keys: AppRecord['keys'], extra?: AppRecord['extra']): AppRecord {
  return { model: choice.model, models: listed(choice), smallModel: choice.smallModel ?? null, connectedAt: Date.now(), keys, ...(extra ? { extra } : {}) }
}

/* ------------------------------------------------------------------ OpenCode */

const opencodeFile = (ctx: ConnectContext): string => join(ctx.home, '.config', 'opencode', 'opencode.json')

function opencodeProvider(ctx: ConnectContext, choice: ConnectChoice): Json {
  const ids = withSmall(choice)
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'Eaon',
    options: { baseURL: ctx.info.openaiBaseUrl, apiKey: ctx.info.token },
    models: Object.fromEntries(ids.map((id) => [id, { name: modelLabel(ctx.info, id) }]))
  }
}

/** OpenCode: an OpenAI-compatible `provider.eaon` in the global opencode.json, and it as the default model. */
export const opencode: Connector = {
  id: 'opencode',
  name: 'OpenCode',
  kind: 'config',
  blurb: 'Use your Eaon models in OpenCode.',
  hasSmallModel: true,
  multiModel: true,
  installHint: 'npm install -g opencode-ai',
  note: 'Open OpenCode again to pick it up; the models show under Eaon in /models.',
  files: (ctx) => [opencodeFile(ctx)],
  installed: (ctx) => Boolean(ctx.which('opencode')) || exists(join(ctx.home, '.config', 'opencode')),
  inspect: (ctx, record) =>
    inspectBy(ctx, opencodeFile(ctx), record, [
      [['provider', 'eaon', 'options', 'baseURL'], ctx.info.openaiBaseUrl],
      [['provider', 'eaon', 'options', 'apiKey'], ctx.info.token]
    ]),
  connect: (ctx, choice, previous) => {
    const file = opencodeFile(ctx)
    const { records, written } = ownJsonKeys(
      ctx,
      file,
      [
        [['provider', 'eaon'], opencodeProvider(ctx, choice)],
        [['model'], `eaon/${choice.model}`],
        [['small_model'], `eaon/${small(choice)}`]
      ],
      previous?.keys[file]
    )
    return { record: record(choice, { [file]: records }), written: [written] }
  },
  disconnect: (ctx, rec) => releaseJsonKeys(ctx, opencodeFile(ctx), rec.keys[opencodeFile(ctx)]),
  launch: () => ({ env: {}, command: 'opencode' }),
  manual: (ctx, choice) =>
    [
      'Add to ~/.config/opencode/opencode.json:',
      JSON.stringify({ provider: { eaon: opencodeProvider(ctx, choice) }, model: `eaon/${choice.model}`, small_model: `eaon/${small(choice)}` }, null, 2)
    ].join('\n')
}

/* ------------------------------------------------------------------ OpenClaw */

const openclawFile = (ctx: ConnectContext): string => join(ctx.home, '.openclaw', 'openclaw.json')

function openclawProvider(ctx: ConnectContext, choice: ConnectChoice): Json {
  const ids = withSmall(choice)
  return {
    baseUrl: ctx.info.openaiBaseUrl,
    apiKey: ctx.info.token,
    api: 'openai-completions',
    models: ids.map((id) => ({ id, name: modelLabel(ctx.info, id) }))
  }
}

/**
 * OpenClaw: `models.providers.eaon` and `agents.defaults.model.primary` in
 * openclaw.json. The file may be JSON5; one with comments is refused (see
 * readJson) and Copy settings is offered instead.
 */
export const openclaw: Connector = {
  id: 'openclaw',
  name: 'OpenClaw',
  kind: 'config',
  blurb: 'Use your Eaon models in OpenClaw.',
  hasSmallModel: false,
  multiModel: true,
  installHint: 'npm install -g openclaw',
  note: 'Restart OpenClaw (openclaw gateway restart) to pick it up.',
  files: (ctx) => [openclawFile(ctx)],
  installed: (ctx) => Boolean(ctx.which('openclaw')) || exists(join(ctx.home, '.openclaw')),
  inspect: (ctx, record) =>
    inspectBy(ctx, openclawFile(ctx), record, [
      [['models', 'providers', 'eaon', 'baseUrl'], ctx.info.openaiBaseUrl],
      [['models', 'providers', 'eaon', 'apiKey'], ctx.info.token]
    ]),
  connect: (ctx, choice, previous) => {
    const file = openclawFile(ctx)
    const { records, written } = ownJsonKeys(
      ctx,
      file,
      [
        [['models', 'providers', 'eaon'], openclawProvider(ctx, choice)],
        [['agents', 'defaults', 'model', 'primary'], `eaon/${choice.model}`]
      ],
      previous?.keys[file]
    )
    return { record: record(choice, { [file]: records }), written: [written] }
  },
  disconnect: (ctx, rec) => releaseJsonKeys(ctx, openclawFile(ctx), rec.keys[openclawFile(ctx)]),
  launch: () => ({ env: {}, command: 'openclaw' }),
  manual: (ctx, choice) =>
    [
      'Add to ~/.openclaw/openclaw.json:',
      JSON.stringify(
        { models: { providers: { eaon: openclawProvider(ctx, choice) } }, agents: { defaults: { model: { primary: `eaon/${choice.model}` } } } },
        null,
        2
      )
    ].join('\n')
}

/* ------------------------------------------------------------------ Pi */

const piModels = (ctx: ConnectContext): string => join(ctx.home, '.pi', 'agent', 'models.json')
const piSettings = (ctx: ConnectContext): string => join(ctx.home, '.pi', 'agent', 'settings.json')

function piProvider(ctx: ConnectContext, choice: ConnectChoice): Json {
  return {
    baseUrl: ctx.info.openaiBaseUrl,
    api: 'openai-completions',
    apiKey: ctx.info.token,
    models: withSmall(choice).map((id) => ({ id, name: modelLabel(ctx.info, id) }))
  }
}

/** Pi: `providers.eaon` in models.json, and it as the default in settings.json. */
export const pi: Connector = {
  id: 'pi',
  name: 'Pi',
  kind: 'config',
  blurb: 'Use your Eaon models in Pi.',
  hasSmallModel: false,
  multiModel: true,
  installHint: 'npm install -g @earendil-works/pi-coding-agent',
  note: 'Start Pi again to pick it up.',
  files: (ctx) => [piModels(ctx), piSettings(ctx)],
  installed: (ctx) => Boolean(ctx.which('pi')) || exists(join(ctx.home, '.pi')),
  inspect: (ctx, record) =>
    inspectBy(ctx, piModels(ctx), record, [
      [['providers', 'eaon', 'baseUrl'], ctx.info.openaiBaseUrl],
      [['providers', 'eaon', 'apiKey'], ctx.info.token]
    ]),
  connect: (ctx, choice, previous) => {
    const models = ownJsonKeys(ctx, piModels(ctx), [[['providers', 'eaon'], piProvider(ctx, choice)]], previous?.keys[piModels(ctx)])
    const settings = ownJsonKeys(
      ctx,
      piSettings(ctx),
      [
        [['defaultProvider'], 'eaon'],
        [['defaultModel'], choice.model]
      ],
      previous?.keys[piSettings(ctx)]
    )
    return {
      record: record(choice, { [piModels(ctx)]: models.records, [piSettings(ctx)]: settings.records }),
      written: [models.written, settings.written]
    }
  },
  disconnect: (ctx, rec) => {
    releaseJsonKeys(ctx, piModels(ctx), rec.keys[piModels(ctx)])
    releaseJsonKeys(ctx, piSettings(ctx), rec.keys[piSettings(ctx)])
  },
  launch: () => ({ env: {}, command: 'pi' }),
  manual: (ctx, choice) =>
    [
      'Add to ~/.pi/agent/models.json:',
      JSON.stringify({ providers: { eaon: piProvider(ctx, choice) } }, null, 2),
      '',
      'And to ~/.pi/agent/settings.json:',
      JSON.stringify({ defaultProvider: 'eaon', defaultModel: choice.model }, null, 2)
    ].join('\n')
}

/* ------------------------------------------------------------------ Droid */

const droidFile = (ctx: ConnectContext): string => join(ctx.home, '.factory', 'settings.json')
const EAON_SUFFIX = ' (Eaon)'

type DroidModel = { model: string; displayName: string; baseUrl: string; apiKey: string; provider: string; maxOutputTokens: number }

function droidModels(ctx: ConnectContext, choice: ConnectChoice): DroidModel[] {
  return withSmall(choice).map((id) => ({
    model: id,
    displayName: `${modelLabel(ctx.info, id)}${EAON_SUFFIX}`,
    baseUrl: ctx.info.openaiBaseUrl,
    apiKey: ctx.info.token,
    provider: 'generic-chat-completion-api',
    maxOutputTokens: 16384
  }))
}

/** One of Eaon's own entries: named "… (Eaon)" and pointed at this machine. */
const isEaonEntry = (entry: unknown): boolean =>
  Boolean(entry && typeof entry === 'object') &&
  String((entry as Json).displayName ?? '').endsWith(EAON_SUFFIX) &&
  /^http:\/\/127\.0\.0\.1:\d+\//.test(String((entry as Json).baseUrl ?? ''))

/**
 * Droid (Factory): entries in `customModels` of ~/.factory/settings.json (the
 * camelCase file; the older config.json is still read by Droid but
 * settings.json wins). Droid has no default-model setting to write: the
 * models show in /model under Custom models.
 */
export const droid: Connector = {
  id: 'droid',
  name: 'Droid',
  kind: 'config',
  blurb: 'Use your Eaon models in Droid.',
  hasSmallModel: false,
  multiModel: true,
  installHint: 'curl -fsSL https://app.factory.ai/cli | sh',
  note: 'Run droid again and pick the model with /model, under Custom models.',
  files: (ctx) => [droidFile(ctx)],
  installed: (ctx) => Boolean(ctx.which('droid')) || exists(join(ctx.home, '.factory')),
  inspect: (ctx) => {
    try {
      const entries = (readJson(droidFile(ctx), ctx.home).customModels as unknown[]) ?? []
      const ours = Array.isArray(entries) ? entries.filter(isEaonEntry) : []
      if (ours.length === 0) return { connected: false, stale: false }
      const current = ours.every((e) => (e as Json).baseUrl === ctx.info.openaiBaseUrl && (e as Json).apiKey === ctx.info.token)
      return { connected: true, stale: !current, model: String((ours[0] as Json).model), models: ours.map((e) => String((e as Json).model)) }
    } catch {
      return { connected: false, stale: false }
    }
  },
  connect: (ctx, choice, previous) => {
    const file = droidFile(ctx)
    const data = readJson(file, ctx.home)
    const had = previous?.extra?.hadCustomModels ?? Array.isArray(data.customModels)
    const others = Array.isArray(data.customModels) ? data.customModels.filter((e) => !isEaonEntry(e)) : []
    data.customModels = [...others, ...droidModels(ctx, choice)]
    writeJson(file, data)
    return {
      record: record(choice, {}, { hadCustomModels: had }),
      written: [{ path: file, keys: ['customModels'] }]
    }
  },
  disconnect: (ctx, rec) => {
    const file = droidFile(ctx)
    if (!exists(file)) return
    const data = readJson(file, ctx.home)
    if (!Array.isArray(data.customModels)) return
    const others = data.customModels.filter((e) => !isEaonEntry(e))
    if (others.length === 0 && !rec.extra?.hadCustomModels) delete data.customModels
    else data.customModels = others
    writeJsonBack(file, data)
  },
  launch: () => ({ env: {}, command: 'droid' }),
  manual: (ctx, choice) => ['Add to "customModels" in ~/.factory/settings.json:', JSON.stringify(droidModels(ctx, choice), null, 2)].join('\n')
}

/* ------------------------------------------------------------------ Qwen Code */

const qwenFile = (ctx: ConnectContext): string => join(ctx.home, '.qwen', 'settings.json')
const QWEN_MARK = 'Added by Eaon'

function qwenEntries(ctx: ConnectContext, choice: ConnectChoice): Json[] {
  return listed(choice).map((id) => ({
    id,
    name: `${modelLabel(ctx.info, id)}${EAON_SUFFIX}`,
    baseUrl: ctx.info.openaiBaseUrl,
    envKey: 'EAON_API_KEY',
    description: QWEN_MARK
  }))
}

const isQwenEntry = (entry: unknown): boolean => Boolean(entry && typeof entry === 'object' && (entry as Json).description === QWEN_MARK)

/**
 * Qwen Code: an `openai` entry in `modelProviders` of ~/.qwen/settings.json
 * whose key comes from the file's own `env` block, selected through
 * `security.auth.selectedType` and `model.name`.
 */
export const qwenCode: Connector = {
  id: 'qwen-code',
  name: 'Qwen Code',
  kind: 'config',
  blurb: 'Use your Eaon models in Qwen Code.',
  hasSmallModel: false,
  multiModel: true,
  installHint: 'npm install -g @qwen-code/qwen-code',
  note: 'Start qwen again to pick it up.',
  files: (ctx) => [qwenFile(ctx)],
  installed: (ctx) => Boolean(ctx.which('qwen')) || exists(join(ctx.home, '.qwen')),
  inspect: (ctx, rec) => {
    try {
      const data = readJson(qwenFile(ctx), ctx.home)
      const list = getPath(data, ['modelProviders', 'openai'])
      const ours = Array.isArray(list) ? list.filter(isQwenEntry) : []
      if (ours.length === 0) return { connected: false, stale: false }
      const current = ours.every((e) => (e as Json).baseUrl === ctx.info.openaiBaseUrl) && getPath(data, ['env', 'EAON_API_KEY']) === ctx.info.token
      return { connected: true, stale: !current, model: rec?.model ?? null }
    } catch {
      return { connected: false, stale: false }
    }
  },
  connect: (ctx, choice, previous) => {
    const file = qwenFile(ctx)
    const data = readJson(file, ctx.home)
    const list = getPath(data, ['modelProviders', 'openai'])
    const had = previous?.extra?.hadOpenaiList ?? Array.isArray(list)
    const others = Array.isArray(list) ? list.filter((e) => !isQwenEntry(e)) : []
    const providers = (data.modelProviders && typeof data.modelProviders === 'object' ? data.modelProviders : {}) as Json
    providers.openai = [...others, ...qwenEntries(ctx, choice)]
    data.modelProviders = providers
    writeJson(file, data)
    const { records, written } = ownJsonKeys(
      ctx,
      file,
      [
        [['env', 'EAON_API_KEY'], ctx.info.token],
        [['security', 'auth', 'selectedType'], 'openai'],
        [['model', 'name'], choice.model]
      ],
      previous?.keys[file]
    )
    return {
      record: record(choice, { [file]: records }, { hadOpenaiList: had }),
      written: [{ path: file, keys: ['modelProviders.openai', ...written.keys] }]
    }
  },
  disconnect: (ctx, rec) => {
    const file = qwenFile(ctx)
    if (!exists(file)) return
    const data = readJson(file, ctx.home)
    const list = getPath(data, ['modelProviders', 'openai'])
    if (Array.isArray(list)) {
      const others = list.filter((e) => !isQwenEntry(e))
      const providers = data.modelProviders as Json
      if (others.length === 0 && !rec.extra?.hadOpenaiList) {
        delete providers.openai
        if (Object.keys(providers).length === 0) delete data.modelProviders
      } else providers.openai = others
      writeJsonBack(file, data)
    }
    releaseJsonKeys(ctx, file, rec.keys[file])
  },
  launch: () => ({ env: {}, command: 'qwen' }),
  manual: (ctx, choice) =>
    [
      'Add to ~/.qwen/settings.json:',
      JSON.stringify(
        {
          env: { EAON_API_KEY: ctx.info.token },
          modelProviders: { openai: qwenEntries(ctx, choice) },
          security: { auth: { selectedType: 'openai' } },
          model: { name: choice.model }
        },
        null,
        2
      )
    ].join('\n')
}
