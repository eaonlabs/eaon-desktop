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
  ollamaBaseUrl: "http://127.0.0.1:11434",
  customProviders: [],
  selectedModelKey: null,
  permissionMode: "sandboxed",
  defaultMode: "agent",
  customInstructions: "",
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
export function resolveAquaApiKey(config: EaonConfig): string {
  return process.env.EAON_AQUA_API_KEY || config.aquaApiKey || "";
}

export function resolveOllamaBaseUrl(config: EaonConfig): string {
  return process.env.EAON_OLLAMA_URL || config.ollamaBaseUrl || DEFAULTS.ollamaBaseUrl;
}
