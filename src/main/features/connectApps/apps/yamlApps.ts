import { join } from 'node:path'
import type { ConnectChoice } from '@shared/connectApps'
import { backupOnce, ConfigError, readText, writeBack, writeText } from '../files'
import { exists, listed, modelLabel, type ConnectContext, type Connector } from '../connector'
import { hasChild, removeChild, setChild } from '../yamlBlock'

/* ------------------------------------------------------------------ Hermes */

const hermesHome = (ctx: ConnectContext): string => join(ctx.home, '.hermes')
const hermesConfig = (ctx: ConnectContext): string => join(hermesHome(ctx), 'config.yaml')
const hermesPython = (ctx: ConnectContext): string => join(hermesHome(ctx), 'hermes-agent', 'venv', 'bin', 'python')

/**
 * Hermes keeps everything in one large config.yaml, so Eaon doesn't edit it
 * itself: it runs a few lines of Python with Hermes's own YAML loader and the
 * writer `hermes config set` uses (`utils.atomic_yaml_write`), in Hermes's
 * own virtualenv. Like `hermes config set`, that rewrites the file without
 * its comments; the first time, Eaon keeps a copy (.eaon-backup). Connecting adds `providers.eaon` (Hermes's newer named
 * providers) and selects it with `model.provider: custom:eaon` and
 * `model.default`; it prints the previous model settings, which disconnect
 * puts back, if they still hold Eaon's values.
 */
const HERMES_SCRIPT = String.raw`
import json, os, sys
job = json.load(sys.stdin)
sys.path.insert(0, job["root"])
import yaml
from utils import atomic_yaml_write

path = job["config"]
config = {}
if os.path.exists(path):
    with open(path, encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
model = config.get("model") if isinstance(config.get("model"), dict) else {}
before = {"provider": model.get("provider"), "default": model.get("default"), "providers": "providers" in config, "model": "model" in config}
providers = config.get("providers") if isinstance(config.get("providers"), dict) else {}
if job["action"] == "connect":
    providers["eaon"] = {"name": "Eaon", "base_url": job["base_url"], "api_key": job["api_key"], "default_model": job["model"]}
    config["providers"] = providers
    model["provider"] = "custom:eaon"
    model["default"] = job["model"]
    config["model"] = model
else:
    wrote = job.get("wrote") or {}
    restore = job.get("before") or {}
    providers.pop("eaon", None)
    if providers or restore.get("providers", True):
        config["providers"] = providers
    else:
        config.pop("providers", None)
    for key in ("provider", "default"):
        if model.get(key) == wrote.get(key):
            if restore.get(key) is None:
                model.pop(key, None)
            else:
                model[key] = restore[key]
    if model or restore.get("model", True):
        config["model"] = model
    else:
        config.pop("model", None)
atomic_yaml_write(path, config, sort_keys=False)
print(json.dumps({"before": before}))
`

async function runHermes(ctx: ConnectContext, job: Record<string, unknown>): Promise<{ before: Record<string, unknown> }> {
  if (!ctx.run) throw new ConfigError('Eaon can\'t run Hermes here.')
  if (!exists(hermesPython(ctx))) {
    throw new ConfigError('Hermes isn\'t installed where Eaon expects it (~/.hermes/hermes-agent). Use Copy settings and run the commands yourself.')
  }
  backupOnce(hermesConfig(ctx))
  const out = await ctx.run(hermesPython(ctx), ['-c', HERMES_SCRIPT], JSON.stringify({ ...job, root: join(hermesHome(ctx), 'hermes-agent'), config: hermesConfig(ctx) }))
  return JSON.parse(out.trim().split('\n').pop() ?? '{}') as { before: Record<string, unknown> }
}

function inspectHermes(ctx: ConnectContext): { connected: boolean; stale: boolean } {
  const text = readText(hermesConfig(ctx))
  if (!text || !/provider:\s*["']?custom:eaon["']?/.test(text)) return { connected: false, stale: false }
  try {
    if (!hasChild(text, 'providers', 'eaon')) return { connected: false, stale: false }
  } catch {
    return { connected: false, stale: false }
  }
  const current = text.includes(ctx.info.openaiBaseUrl) && text.includes(ctx.info.token)
  return { connected: true, stale: !current }
}

function hermesConnector(id: 'hermes' | 'hermes-desktop'): Connector {
  return {
    id,
    name: id === 'hermes' ? 'Hermes Agent' : 'Hermes Desktop',
    kind: 'config',
    blurb: id === 'hermes' ? 'Use your Eaon models in Hermes Agent.' : 'Use your Eaon models in the Hermes desktop app.',
    hasSmallModel: false,
    installHint: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
    note: 'Hermes Agent and Hermes Desktop share one setting, so this connects both. Start a new Hermes session to pick it up.',
    files: (ctx) => [hermesConfig(ctx)],
    installed: (ctx) => Boolean(ctx.which('hermes')) || exists(hermesConfig(ctx)),
    inspect: (ctx) => inspectHermes(ctx),
    connect: async (ctx, choice, previous) => {
      const out = await runHermes(ctx, { action: 'connect', base_url: ctx.info.openaiBaseUrl, api_key: ctx.info.token, model: choice.model })
      return {
        record: {
          model: choice.model,
          smallModel: null,
          connectedAt: Date.now(),
          keys: {},
          extra: { before: previous?.extra?.before ?? out.before, wrote: { provider: 'custom:eaon', default: choice.model } }
        },
        written: [{ path: hermesConfig(ctx), keys: ['providers.eaon', 'model.provider', 'model.default'] }]
      }
    },
    disconnect: async (ctx, rec) => {
      if (!exists(hermesConfig(ctx))) return
      await runHermes(ctx, { action: 'disconnect', before: rec.extra?.before ?? {}, wrote: rec.extra?.wrote ?? {} })
    },
    launch: () => ({ env: {}, command: id === 'hermes' ? 'hermes' : 'hermes desktop' }),
    manual: (ctx, choice) =>
      [
        'Run these in a terminal:',
        `hermes config set providers.eaon.name Eaon`,
        `hermes config set providers.eaon.base_url ${ctx.info.openaiBaseUrl}`,
        `hermes config set providers.eaon.api_key ${ctx.info.token}`,
        `hermes config set providers.eaon.default_model ${choice.model}`,
        `hermes config set model.provider custom:eaon`,
        `hermes config set model.default ${choice.model}`
      ].join('\n')
  }
}

export const hermes = hermesConnector('hermes')
export const hermesDesktop = hermesConnector('hermes-desktop')

/* ------------------------------------------------------------------ Oh My Pi */

const ompFile = (ctx: ConnectContext): string => join(ctx.home, '.omp', 'agent', 'models.yml')

function ompProvider(ctx: ConnectContext, choice: ConnectChoice): Record<string, unknown> {
  return {
    baseUrl: ctx.info.openaiBaseUrl,
    api: 'openai-completions',
    // omp's `apiKey` names an environment variable; the gateway takes requests with no key.
    auth: 'none',
    models: listed(choice).map((id) => ({ id, name: modelLabel(ctx.info, id) }))
  }
}

/**
 * Oh My Pi: `providers.eaon` in ~/.omp/agent/models.yml. omp has no settings
 * key for the default model that Eaon should write; its docs have you pick
 * it in /model and assign it to Default, which it saves itself.
 */
export const ohMyPi: Connector = {
  id: 'oh-my-pi',
  name: 'Oh My Pi',
  kind: 'config',
  blurb: 'Use your Eaon models in Oh My Pi.',
  hasSmallModel: false,
  multiModel: true,
  installHint: 'See omp.sh',
  note: 'In omp, open /model, find Eaon and assign the model to Default.',
  files: (ctx) => [ompFile(ctx)],
  installed: (ctx) => Boolean(ctx.which('omp')) || exists(join(ctx.home, '.omp')),
  inspect: (ctx) => {
    const text = readText(ompFile(ctx))
    try {
      if (!text || !hasChild(text, 'providers', 'eaon')) return { connected: false, stale: false }
    } catch {
      return { connected: false, stale: false }
    }
    return { connected: true, stale: !text.includes(JSON.stringify(ctx.info.openaiBaseUrl)) }
  },
  connect: (ctx, choice) => {
    const file = ompFile(ctx)
    const existing = readText(file)
    writeText(file, setChild(existing ?? '', 'providers', 'eaon', ompProvider(ctx, choice)))
    return {
      record: { model: choice.model, models: listed(choice), smallModel: null, connectedAt: Date.now(), keys: {} },
      written: [{ path: file, keys: ['providers.eaon'] }]
    }
  },
  disconnect: (ctx) => {
    const file = ompFile(ctx)
    const text = readText(file)
    if (text === null) return
    writeBack(file, removeChild(text, 'providers', 'eaon'))
  },
  launch: () => ({ env: {}, command: 'omp' }),
  manual: (ctx, choice) =>
    ['Add to ~/.omp/agent/models.yml:', setChild('', 'providers', 'eaon', ompProvider(ctx, choice)).trimEnd(), '', 'Then pick it in /model and assign it to Default.'].join('\n')
}
