// Persisted settings — the CLI equivalent of the Mac app's UserDefaults /
// the Tauri core's state.json. One JSON file, atomic write (temp + rename)
// so a crash mid-save can't corrupt it.

import fs from "node:fs";
import path from "node:path";
import { configDir } from "./platform.js";
import type { EaonConfig } from "./types.js";

export function configFile(): string {
  return path.join(configDir(), "config.json");
}

const DEFAULTS: EaonConfig = {
  aquaApiKey: "",
  eaonAccountKey: "",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  customProviders: [],
  selectedModelKey: null,
  permissionMode: "sandboxed",
  defaultMode: "agent",
  customInstructions: "",
  // Colour scheme name from ui/themes.ts. An unknown value falls back to the
  // default at apply time, so an old config never blocks startup.
  theme: "opencode",
};

export function loadConfig(): EaonConfig {
  try {
    const raw = fs.readFileSync(configFile(), "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: EaonConfig): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = configFile();
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** Env vars win over the config file — the usual CLI convention (mirrors
 * Claude Code's own ANTHROPIC_API_KEY), useful for CI/scripted use without
 * writing a config file to disk at all. */
/**
 * The chat credential.
 *
 * Falls back to the account key so a fresh install works the moment /login
 * finishes, but prefers `aquaApiKey` when both exist: that field holds whatever
 * the user set up deliberately (a hosted key, or one imported from Eaon
 * Desktop), and signing in should not quietly re-route their models.
 */
export function resolveAquaApiKey(config: EaonConfig): string {
  return process.env.EAON_AQUA_API_KEY || config.aquaApiKey || config.eaonAccountKey || "";
}

/**
 * The Eaon *account* key — the one api.eaon.dev's account routes accept.
 *
 * Kept separate from `aquaApiKey` because that one field was serving two
 * unrelated services: the hosted host (api.aquadevs.com) and Eaon's own gateway.
 * With both in one slot, /login overwrote whatever hosted key the user already
 * had, and the account views could only work for people who happened to have an
 * `sk-eaon-` key in it — which is exactly the "the configured key isn't one"
 * dead end.
 *
 * The `aquaApiKey` fallback is for anyone who pasted an account key into the old
 * field before this split existed.
 */
export function resolveAccountKey(config: EaonConfig): string {
  const explicit = process.env.EAON_ACCOUNT_KEY || config.eaonAccountKey || "";
  if (explicit) return explicit;
  const legacy = config.aquaApiKey || "";
  return legacy.trim().toLowerCase().startsWith("sk-eaon-") ? legacy : "";
}

export function resolveOllamaBaseUrl(config: EaonConfig): string {
  return process.env.EAON_OLLAMA_URL || config.ollamaBaseUrl || DEFAULTS.ollamaBaseUrl;
}
