import type { GatewayDefaults, GatewayInfo } from '@shared/gateway'
import { getLocalServerStatus, startLocalServer } from '../localServer'
import { store } from '../store'
import { gatewayModels, gatewayToken, resolveGatewayModel } from './models'

/**
 * What an app needs to be pointed at Eaon, for the code that connects apps
 * (Claude Code, Codex, OpenCode…): the two base URLs, the key, the models
 * and the defaults that stand in for model names Eaon doesn't have.
 */
export function gatewayInfo(): GatewayInfo {
  const status = getLocalServerStatus()
  const port = status.running ? status.port : store.getSettings().localServer.port || 1337
  const settings = store.getSettings().localServer
  // Reported as `provider/model`, whichever form the setting was saved in.
  const asId = (value: string | null): string | null => (value ? (resolveGatewayModel(value)?.id ?? value) : null)
  return {
    running: status.running,
    port,
    openaiBaseUrl: `http://127.0.0.1:${port}/v1`,
    anthropicBaseUrl: `http://127.0.0.1:${port}`,
    token: gatewayToken(),
    models: gatewayModels(),
    defaultModel: asId(settings.defaultModelId),
    smallModel: asId(settings.smallModelId)
  }
}

/** Starts the server if it is off, and keeps it starting with Eaon from then on. */
export async function ensureGatewayRunning(): Promise<GatewayInfo> {
  if (!store.getSettings().localServer.autoStart) {
    store.patchSettings({ localServer: { ...store.getSettings().localServer, autoStart: true } })
  }
  if (!getLocalServerStatus().running) {
    const status = await startLocalServer()
    if (!status.running) throw new Error(status.error ? `The Local API Server could not start: ${status.error}` : 'The Local API Server could not start.')
  }
  return gatewayInfo()
}

export function setGatewayDefaults(defaults: GatewayDefaults): GatewayInfo {
  const current = store.getSettings().localServer
  store.patchSettings({
    localServer: {
      ...current,
      ...(defaults.defaultModel !== undefined ? { defaultModelId: defaults.defaultModel || null } : {}),
      ...(defaults.smallModel !== undefined ? { smallModelId: defaults.smallModel || null } : {})
    }
  })
  return gatewayInfo()
}
