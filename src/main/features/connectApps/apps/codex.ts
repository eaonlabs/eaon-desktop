import { join } from 'node:path'
import type { ConnectChoice } from '@shared/connectApps'
import { ConfigError, readText, removeFile, writeBack, writeOwnFile, writeText } from '../files'
import { exists, listed, type ConnectContext, type Connector } from '../connector'
import { getTableValue, getTopLevel, removeTable, removeTopLevel, setTable, setTopLevel, tomlString, tomlValue } from '../toml'
import { catalogSlugs, codexCatalog } from './codexCatalog'

/**
 * Codex reads ~/.codex/config.toml, and so does the ChatGPT desktop app's
 * Codex mode (that file holds its plugins and computer-use settings too).
 *
 * - ChatGPT: the top-level `model` and `model_provider` in config.toml point
 *   at a `[model_providers.eaon]` table, and `model_catalog_json` at a model
 *   catalog Eaon writes (~/.codex/eaon-models.json), which is what puts the
 *   models in ChatGPT's model picker (see codexCatalog.ts). That also changes
 *   plain `codex` on the command line; disconnecting puts the three keys back
 *   as they were.
 * - Codex CLI: a profile file, ~/.codex/eaon.config.toml, used with
 *   `codex --profile eaon`, which leaves the default untouched. It names a
 *   catalog of its own (eaon-cli-models.json), as its models are picked
 *   separately.
 *
 * `wire_api = "responses"` (Codex's current protocol) and the gateway key as
 * `experimental_bearer_token`, so no environment variable is needed.
 */

const PROVIDER = 'model_providers.eaon'
const HEADER = '# Written by Eaon'

const configFile = (ctx: ConnectContext): string => join(ctx.home, '.codex', 'config.toml')
const catalogFile = (ctx: ConnectContext): string => join(ctx.home, '.codex', 'eaon-models.json')
const profileFile = (ctx: ConnectContext): string => join(ctx.home, '.codex', 'eaon.config.toml')
const profileCatalogFile = (ctx: ConnectContext): string => join(ctx.home, '.codex', 'eaon-cli-models.json')

/** config.toml's own values for the keys Eaon sets, as raw TOML, from before Eaon's first connect. */
interface Before {
  model: string | null
  provider: string | null
  catalog?: string | null
}

function providerEntries(ctx: ConnectContext): [string, string][] {
  return [
    ['name', tomlString('Eaon')],
    ['base_url', tomlString(ctx.info.openaiBaseUrl)],
    ['wire_api', tomlString('responses')],
    ['experimental_bearer_token', tomlString(ctx.info.token)]
  ]
}

function profileText(ctx: ConnectContext, choice: ConnectChoice): string {
  const lines = [
    `${HEADER} (Settings → Connect apps). Run \`codex --profile eaon\` to use your Eaon models.`,
    `model = ${tomlString(choice.model)}`,
    `model_provider = ${tomlString('eaon')}`,
    `model_catalog_json = ${tomlString(profileCatalogFile(ctx))}`,
    '',
    `[${PROVIDER}]`,
    ...providerEntries(ctx).map(([k, v]) => `${k} = ${v}`)
  ]
  return `${lines.join('\n')}\n`
}

function catalogNote(choice: ConnectChoice): string {
  const count = listed(choice).length
  return count === 1 ? '1 model' : `${count} models`
}

/**
 * Connected: the file selects Eaon's provider. Stale: it points at an older
 * address or key, or doesn't name Eaon's catalog or that catalog is missing
 * (connected by an Eaon from before catalogs, so ChatGPT's picker shows none
 * of the models). `model` may be any of the catalog's: the app saves the one
 * picked in its own picker there.
 */
function inspectToml(ctx: ConnectContext, file: string, catalog: string): { connected: boolean; stale: boolean; model: string | null; models?: string[] } {
  const text = readText(file)
  if (text === null) return { connected: false, stale: false, model: null }
  const base = tomlValue(getTableValue(text, PROVIDER, 'base_url'))
  const token = tomlValue(getTableValue(text, PROVIDER, 'experimental_bearer_token'))
  const selected = tomlValue(getTopLevel(text, 'model_provider')) === 'eaon'
  if (!base || !selected) return { connected: false, stale: false, model: null }
  const model = tomlValue(getTopLevel(text, 'model'))
  const slugs = tomlValue(getTopLevel(text, 'model_catalog_json')) === catalog ? catalogSlugs(readText(catalog)) : null
  return {
    connected: true,
    stale: base !== ctx.info.openaiBaseUrl || token !== ctx.info.token || !slugs,
    model,
    ...(slugs ? { models: slugs } : {})
  }
}

export const chatgpt: Connector = {
  id: 'chatgpt',
  name: 'ChatGPT',
  kind: 'config',
  blurb: 'Use your Eaon models in Codex mode in ChatGPT.',
  hasSmallModel: false,
  multiModel: true,
  desktopApp: 'ChatGPT',
  installHint: 'Get the ChatGPT desktop app from openai.com/chatgpt/download',
  note: 'Your models show in the model picker in Codex mode. Codex on the command line uses the same settings; disconnect to go back to your ChatGPT models.',
  files: (ctx) => [configFile(ctx), catalogFile(ctx)],
  owned: (ctx) => [catalogFile(ctx)],
  installed: (ctx) => (ctx.platform === 'darwin' && exists('/Applications/ChatGPT.app')) || exists(join(ctx.home, '.codex')),
  inspect: (ctx) => inspectToml(ctx, configFile(ctx), catalogFile(ctx)),
  connect: (ctx, choice, previous) => {
    const file = configFile(ctx)
    const catalog = catalogFile(ctx)
    let text = readText(file) ?? ''
    // What was there before Eaon's first connect, kept across reconnects. A record from before
    // Eaon set the catalog has no `catalog`: the file still holds the user's own value for it.
    const recorded = previous?.extra?.before as Before | undefined
    const before: Before = {
      model: recorded ? recorded.model : getTopLevel(text, 'model'),
      provider: recorded ? recorded.provider : getTopLevel(text, 'model_provider'),
      catalog: recorded && 'catalog' in recorded ? (recorded.catalog ?? null) : getTopLevel(text, 'model_catalog_json')
    }
    // The catalog first: a config.toml naming a catalog that isn't there is one Codex ignores whole.
    writeOwnFile(catalog, codexCatalog(ctx.info, listed(choice)))
    text = setTopLevel(text, 'model', tomlString(choice.model))
    text = setTopLevel(text, 'model_provider', tomlString('eaon'))
    text = setTopLevel(text, 'model_catalog_json', tomlString(catalog))
    text = setTable(text, PROVIDER, providerEntries(ctx))
    writeText(file, text.endsWith('\n') ? text : `${text}\n`)
    return {
      record: { model: choice.model, models: listed(choice), smallModel: null, connectedAt: Date.now(), keys: {}, created: [catalog], extra: { before } },
      written: [
        { path: file, keys: ['model', 'model_provider', 'model_catalog_json', `[${PROVIDER}]`] },
        { path: catalog, keys: [catalogNote(choice)] }
      ]
    }
  },
  disconnect: (ctx, rec) => {
    const file = configFile(ctx)
    const catalog = catalogFile(ctx)
    let text = readText(file)
    if (text !== null) {
      const before = rec.extra?.before as Before | undefined
      // Only keys that still hold what Eaon wrote; anything the user changed since stays.
      if (tomlValue(getTopLevel(text, 'model_provider')) === 'eaon') {
        text = before?.provider ? setTopLevel(text, 'model_provider', before.provider) : removeTopLevel(text, 'model_provider')
      }
      // The default Eaon wrote, or another of its models picked in ChatGPT since.
      if ([rec.model, ...(rec.models ?? [])].includes(tomlValue(getTopLevel(text, 'model')) ?? '')) {
        text = before?.model ? setTopLevel(text, 'model', before.model) : removeTopLevel(text, 'model')
      }
      if (tomlValue(getTopLevel(text, 'model_catalog_json')) === catalog) {
        text = before?.catalog ? setTopLevel(text, 'model_catalog_json', before.catalog) : removeTopLevel(text, 'model_catalog_json')
      }
      text = removeTable(text, PROVIDER)
      writeBack(file, text)
    }
    // Only now that config.toml no longer names it.
    removeFile(catalog)
  },
  manual: (ctx, choice) =>
    [
      'In ~/.codex/config.toml, set these top-level keys:',
      `model = ${tomlString(choice.model)}`,
      'model_provider = "eaon"',
      '',
      'and add this table:',
      `[${PROVIDER}]`,
      ...providerEntries(ctx).map(([k, v]) => `${k} = ${v}`),
      '',
      'ChatGPT lists only the models in its catalog, so set by hand it uses this model without showing it in the picker. Connect writes the catalog too.'
    ].join('\n')
}

export const codexCli: Connector = {
  id: 'codex-cli',
  name: 'Codex CLI',
  kind: 'config',
  blurb: 'Run Codex in your terminal with your Eaon models.',
  hasSmallModel: false,
  multiModel: true,
  installHint: 'npm install -g @openai/codex',
  note: 'Start it with `codex --profile eaon` and switch models with /model. Plain `codex` keeps its usual models.',
  files: (ctx) => [profileFile(ctx), profileCatalogFile(ctx)],
  owned: (ctx) => [profileCatalogFile(ctx)],
  installed: (ctx) => Boolean(ctx.which('codex')),
  inspect: (ctx) => inspectToml(ctx, profileFile(ctx), profileCatalogFile(ctx)),
  connect: (ctx, choice) => {
    const file = profileFile(ctx)
    const catalog = profileCatalogFile(ctx)
    const existing = readText(file)
    if (existing !== null && !existing.startsWith(HEADER)) {
      throw new ConfigError('~/.codex/eaon.config.toml already exists and wasn\'t written by Eaon, so Eaon won\'t replace it. Rename it, or use Copy settings.')
    }
    writeOwnFile(catalog, codexCatalog(ctx.info, listed(choice)))
    writeOwnFile(file, profileText(ctx, choice))
    return {
      record: { model: choice.model, models: listed(choice), smallModel: null, connectedAt: Date.now(), keys: {}, created: [file, catalog] },
      written: [
        { path: file, keys: ['model', 'model_provider', 'model_catalog_json', `[${PROVIDER}]`] },
        { path: catalog, keys: [catalogNote(choice)] }
      ]
    }
  },
  disconnect: (ctx) => {
    const file = profileFile(ctx)
    const text = readText(file)
    if (text !== null && text.startsWith(HEADER)) removeFile(file)
    if (!exists(file)) removeFile(profileCatalogFile(ctx))
  },
  launch: () => ({ env: {}, command: 'codex --profile eaon' }),
  manual: (ctx, choice) =>
    [
      'Save as ~/.codex/eaon.config.toml, then run `codex --profile eaon`:',
      profileText(ctx, choice).replace(/^model_catalog_json = .*\n/m, '')
    ].join('\n')
}
