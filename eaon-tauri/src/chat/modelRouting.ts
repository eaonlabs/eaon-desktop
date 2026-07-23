// Model routing — resolves a picker ModelEntry to the connection that serves
// it (base URL, credential, wire format), the modular port of REF
// state.svelte.ts's `endpointFor` + `samplingFields`. New over REF: the
// Free Week trial path (signed headers instead of a bearer key) and the
// per-connection wire format for BYOK.

import type { ModelEntry, ModelParams, ProviderFormat, TrialCredential } from "../core/types";
import { EAON_HOSTED_BASE_URL, EAON_TRIAL_BASE_URL } from "../core/catalog";
import { trialDeviceHash } from "../core/ipc";
import { useSettings } from "../state/settings";

export interface ResolvedRoute {
  baseUrl: string;
  apiKey: string | null;
  /** Free Week signing material — set only when no user key exists; Rust
   *  signs each request with these instead of a bearer header. */
  trialDevice: string | null;
  trialSecret: string | null;
  format: ProviderFormat;
  /** The id sent in the request "model" field. */
  requestModel: string;
}

/** The device hash never changes for an install, so one IPC round-trip per
 *  app run is enough; a failed read clears the cache so a retry can work. */
let cachedDeviceHash: Promise<string> | null = null;
function deviceHash(): Promise<string> {
  cachedDeviceHash ??= trialDeviceHash().catch((e) => {
    cachedDeviceHash = null;
    throw e;
  });
  return cachedDeviceHash;
}

/** The credential if it's usable right now, null when absent/expired. The
 *  server mints expiry in unix seconds but defensively accept ms too — a
 *  wrong unit here would silently kill the whole trial feature. */
export function activeTrial(credential: TrialCredential | null): TrialCredential | null {
  if (!credential || !credential.key || !credential.secret) return null;
  const expiresMs = credential.expiresAt > 1e12 ? credential.expiresAt : credential.expiresAt * 1000;
  return expiresMs > Date.now() ? credential : null;
}

/** Resolve where a chat request for this model goes. A user-entered key
 *  always wins over the trial (the Free Week rule from FreeWeekTrial). */
export async function resolveRoute(entry: ModelEntry): Promise<ResolvedRoute | { error: string }> {
  const { settings } = useSettings.getState();
  switch (entry.provider.kind) {
    case "eaon": {
      const key = settings.eaonApiKey.trim();
      if (key) {
        return {
          baseUrl: EAON_HOSTED_BASE_URL,
          apiKey: key,
          trialDevice: null,
          trialSecret: null,
          format: "openai",
          requestModel: entry.requestId,
        };
      }
      const trial = activeTrial(settings.trialCredential);
      if (trial) {
        try {
          return {
            // The trial credential is only valid against Eaon's own
            // gateway — NOT the aquadevs.com host user-key requests use.
            // Signing a request correctly and then sending it to the wrong
            // domain is the same as not signing it: the trial credential
            // would never actually work for a real chat request, only for
            // the (separately-routed) trial_start/trial_status IPC calls
            // in trial.rs, which already hit the right host.
            baseUrl: EAON_TRIAL_BASE_URL,
            apiKey: null,
            trialDevice: await deviceHash(),
            trialSecret: trial.secret,
            format: "openai",
            requestModel: entry.requestId,
          };
        } catch {
          // No machine id readable — fall through to the setup message
          // rather than sending an unsignable request.
        }
      }
      return { error: "Add your Eaon API key or start the Free Week in Settings → Providers." };
    }
    case "ollama":
      // Ollama serves an OpenAI-compatible surface under /v1 (REF endpointFor).
      return {
        baseUrl: `${settings.ollamaBaseUrl}/v1`,
        apiKey: null,
        trialDevice: null,
        trialSecret: null,
        format: "openai",
        requestModel: entry.requestId,
      };
    case "custom": {
      const configId = entry.provider.configId;
      const config = settings.customProviders.find((c) => c.id === configId);
      if (!config || !config.baseURL) {
        return { error: "This model's provider connection was removed — pick another model or re-add the connection in Settings → Providers." };
      }
      return {
        baseUrl: config.baseURL,
        apiKey: config.apiKey || null,
        trialDevice: null,
        trialSecret: null,
        // Legacy rows may predate the format field; "openai" is the migration default.
        format: config.format ?? "openai",
        requestModel: entry.requestId,
      };
    }
  }
}

/** The sampling fields to send — only what the user switched on; null when
 *  nothing is, so the request is byte-identical to before the feature
 *  existed (REF samplingFields; reasoning models reject a neutral
 *  temperature, which is why off means absent, not 0.7). */
export function samplingBody(params: ModelParams): Record<string, unknown> | null {
  const fields: Record<string, unknown> = {};
  if (params.temperatureEnabled) fields.temperature = params.temperature;
  if (params.topPEnabled) fields.top_p = params.topP;
  if (params.maxTokensEnabled) fields.max_tokens = params.maxTokens;
  if (params.frequencyPenaltyEnabled) fields.frequency_penalty = params.frequencyPenalty;
  if (params.presencePenaltyEnabled) fields.presence_penalty = params.presencePenalty;
  return Object.keys(fields).length ? fields : null;
}
