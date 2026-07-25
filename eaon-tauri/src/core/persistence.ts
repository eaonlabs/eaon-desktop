// Loading, migrating, and debounced saving of the one state.json blob.
// The file location (app data dir) and name are unchanged from 2026.3.x, so
// updating over an old install finds its data; the shape difference is
// absorbed by migrateLegacyState below.

import { loadAppState, saveAppState } from "./ipc";
import type { AppStateBlob, CustomProvider, Settings, Statistics } from "./types";
import { DEFAULT_OLLAMA_URL } from "./catalog";
import { isLikelyUsefulMemory } from "./protocol/memory";

export const DEFAULT_MODEL_PARAMS = {
  temperatureEnabled: false, temperature: 0.7,
  topPEnabled: false, topP: 1.0,
  maxTokensEnabled: false, maxTokens: 2048,
  frequencyPenaltyEnabled: false, frequencyPenalty: 0,
  presencePenaltyEnabled: false, presencePenalty: 0,
};

export const DEFAULT_SETTINGS: Settings = {
  theme: "Dark",
  fontSize: "Medium",
  accentColorId: "default",
  fontId: "space-grotesk",
  coloredUserBubble: false,
  showTokenSpeed: true,
  autoUpdateEnabled: true,
  customInstructions: "",
  eaonApiKey: "",
  trialCredential: null,
  customProviders: [],
  ollamaBaseUrl: DEFAULT_OLLAMA_URL,
  webSearchEnabled: true,
  alwaysAllowTools: true,
  deviceControlEnabled: false,
  agentWorkspace: null,
  proxyEnabled: false,
  proxyUrl: "",
  hasSeenOnboarding: false,
  favorites: [],
  nicknames: {},
  hiddenModelKeys: [],
  disabledProviders: [],
  skills: [],
  memories: [],
  memoryEnabled: true,
  memoryJunkPruneDone: false,
  imageProviders: [],
  imageToolEnabled: true,
  modelParams: { ...DEFAULT_MODEL_PARAMS },
  mcpServers: [],
  builtinMcpConnections: [],
  localServerEnabled: false,
  localServerPort: 1234,
  localServerRequireApiKey: true,
  localServerApiKey: "",
};

export const DEFAULT_STATISTICS: Statistics = {
  promptsSent: 0,
  charsGenerated: 0,
  perModel: {},
};

function emptyBlob(): AppStateBlob {
  return {
    schemaVersion: 2,
    conversations: [],
    projects: [],
    currentId: null,
    settings: structuredClone(DEFAULT_SETTINGS),
    statistics: structuredClone(DEFAULT_STATISTICS),
  };
}

/** "eaon:x" was "aqua:x" before schema v2 — rewrite picker-key prefixes in
 *  favorites/nicknames so an updated install keeps its stars and names. */
function migrateModelKey(key: string): string {
  return key.startsWith("aqua:") ? `eaon:${key.slice("aqua:".length)}` : key;
}

/** Absorbs the 2026.3.x blob (no schemaVersion): aquaApiKey → eaonApiKey,
 *  "aqua:" prefixes → "eaon:", BYOK connections gain format "openai",
 *  accent id "aqua" → "eaon". Unknown fields drop; missing take defaults. */
function migrateLegacyState(raw: Record<string, unknown>): AppStateBlob {
  const blob = emptyBlob();
  if (Array.isArray(raw.conversations)) blob.conversations = raw.conversations as AppStateBlob["conversations"];
  if (Array.isArray(raw.projects)) blob.projects = raw.projects as AppStateBlob["projects"];
  if (typeof raw.currentId === "string") blob.currentId = raw.currentId;

  const legacy = (raw.settings ?? {}) as Record<string, unknown>;
  const settings = blob.settings as unknown as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key in legacy) settings[key] = legacy[key];
  }
  if (typeof legacy.aquaApiKey === "string") blob.settings.eaonApiKey = legacy.aquaApiKey;
  if (blob.settings.accentColorId === "aqua") blob.settings.accentColorId = "eaon";
  blob.settings.favorites = (blob.settings.favorites ?? []).map(migrateModelKey);
  blob.settings.nicknames = Object.fromEntries(
    Object.entries(blob.settings.nicknames ?? {}).map(([k, v]) => [migrateModelKey(k), v]),
  );
  blob.settings.customProviders = (blob.settings.customProviders ?? []).map((p) => {
    const legacy = p as Partial<CustomProvider>;
    return { ...legacy, format: legacy.format ?? "openai" } as CustomProvider;
  });
  if (raw.statistics && typeof raw.statistics === "object") {
    blob.statistics = { ...DEFAULT_STATISTICS, ...(raw.statistics as Statistics) };
  }
  return blob;
}

/** Fills defaults for fields added after a given v2 blob was written —
 *  the decode-safety rule: every post-release field must tolerate absence. */
function hydrate(blob: AppStateBlob): AppStateBlob {
  blob.settings = { ...structuredClone(DEFAULT_SETTINGS), ...blob.settings };
  blob.settings.modelParams = { ...DEFAULT_MODEL_PARAMS, ...blob.settings.modelParams };
  blob.statistics = { ...structuredClone(DEFAULT_STATISTICS), ...blob.statistics };
  blob.conversations ??= [];
  blob.projects ??= [];
  blob.currentId ??= null;
  for (const c of blob.conversations) {
    c.messages ??= [];
    for (const m of c.messages) m.reasoning ??= "";
  }
  // One-time cleanup of junk extracted before the isLikelyUsefulMemory gate
  // existed — the Mac app's live stores held dozens of implementation-detail
  // "facts" ("Tools: write_file…", "File structure: src/app.js…") that kept
  // polluting every related conversation, and this port extracted with the
  // same weak prompt until now. Runs once (versioned flag), using exactly
  // the filter new extractions go through; a manual entry that happens to
  // match a junk shape is also removed in this one pass — accepted, since
  // the shapes are code-fragment patterns no one writes about themselves.
  if (!blob.settings.memoryJunkPruneDone) {
    blob.settings.memoryJunkPruneDone = true;
    blob.settings.memories = blob.settings.memories.filter((m) => isLikelyUsefulMemory(m.text));
  }
  return blob;
}

/** Loads the persisted blob, migrating legacy shapes; a missing or corrupt
 *  file yields a fresh default state rather than a crash. */
export async function loadPersistedState(): Promise<AppStateBlob> {
  let text = "";
  try {
    text = await loadAppState();
  } catch {
    return emptyBlob();
  }
  if (!text.trim()) return emptyBlob();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyBlob();
  }
  if (!parsed || typeof parsed !== "object") return emptyBlob();
  const raw = parsed as Record<string, unknown>;
  if (raw.schemaVersion === 2) return hydrate(raw as unknown as AppStateBlob);
  return migrateLegacyState(raw);
}

// ---------------------------------------------------------------------------
// Debounced save — call scheduleSave with a snapshot getter; consecutive
// mutations coalesce into one disk write. flushSave() runs on window close.
// ---------------------------------------------------------------------------

let pending: number | null = null;
let latestSnapshot: (() => AppStateBlob) | null = null;

export function scheduleSave(snapshot: () => AppStateBlob): void {
  latestSnapshot = snapshot;
  if (pending !== null) return;
  pending = window.setTimeout(() => {
    pending = null;
    void flushSave();
  }, 400);
}

export async function flushSave(): Promise<void> {
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }
  if (!latestSnapshot) return;
  try {
    await saveAppState(JSON.stringify(latestSnapshot()));
  } catch (e) {
    // A failed save must never take the app down; the next mutation retries.
    console.error("state save failed", e);
  }
}
