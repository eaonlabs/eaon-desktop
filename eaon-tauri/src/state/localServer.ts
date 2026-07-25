// Shared control for the Local API server — the Settings pane and app
// startup both need to snapshot upstreams and start the listener, and this
// is the one copy of that logic. The autostart half is what makes the
// enabled toggle survive a relaunch: Rust's listener dies with the process,
// so "enabled" is a promise the frontend has to re-keep every launch.

import { EAON_HOSTED_BASE_URL, generateLocalServerKey } from "../core/catalog";
import {
  localServerRunning,
  startLocalServer,
  type LocalServerUpstream,
} from "../core/ipc";
import { useModels } from "./models";
import { useSettings } from "./settings";
import { useUi } from "./ui";

/** Snapshot every reachable model into upstream groups: hosted models share
 *  the Eaon connection, each BYOK provider is its own upstream, and Ollama
 *  is proxied through its own /v1 endpoint. */
export function buildUpstreams(): LocalServerUpstream[] {
  const entries = useModels.getState().entries();
  const { settings } = useSettings.getState();
  const upstreams: LocalServerUpstream[] = [];

  const eaonIds = entries.filter((e) => e.provider.kind === "eaon").map((e) => e.requestId);
  if (eaonIds.length > 0) {
    upstreams.push({
      modelIds: eaonIds,
      baseUrl: EAON_HOSTED_BASE_URL,
      apiKey: settings.eaonApiKey || settings.trialCredential?.key || null,
    });
  }
  for (const provider of settings.customProviders) {
    if (provider.modelIDs.length === 0) continue;
    upstreams.push({
      modelIds: provider.modelIDs,
      baseUrl: provider.baseURL,
      apiKey: provider.apiKey || null,
    });
  }
  const ollamaIds = entries.filter((e) => e.provider.kind === "ollama").map((e) => e.requestId);
  if (ollamaIds.length > 0) {
    upstreams.push({
      modelIds: ollamaIds,
      baseUrl: `${settings.ollamaBaseUrl.replace(/\/+$/, "")}/v1`,
    });
  }
  return upstreams;
}

/** The persisted bearer key, minting (and saving) one on first need. */
export function ensureLocalServerKey(): string {
  const { settings, update } = useSettings.getState();
  if (settings.localServerApiKey) return settings.localServerApiKey;
  const key = generateLocalServerKey();
  update({ localServerApiKey: key });
  return key;
}

/** Start the listener from current settings + model state. Throws with the
 *  Rust-side reason (port in use, …) so callers can show/report it. */
export async function startLocalServerFromSettings(): Promise<void> {
  const key = ensureLocalServerKey();
  const { settings } = useSettings.getState();
  await startLocalServer({
    port: settings.localServerPort,
    requireApiKey: settings.localServerRequireApiKey,
    apiKey: key,
    upstreams: buildUpstreams(),
  });
}

/** App-launch autostart: bring the server back if the user left it enabled.
 *  Called after the model refreshes settle so the upstream snapshot isn't
 *  empty at boot. A failed start flips the setting off and says so — the
 *  toggle must never show ON while nothing is listening. */
export async function autostartLocalServer(): Promise<void> {
  const { settings, update } = useSettings.getState();
  if (!settings.localServerEnabled) return;
  if (await localServerRunning()) return;
  try {
    await startLocalServerFromSettings();
  } catch (e) {
    update({ localServerEnabled: false });
    const reason = e instanceof Error ? e.message : String(e);
    useUi.getState().showToast(`Local API server couldn't start: ${reason}`);
  }
}
