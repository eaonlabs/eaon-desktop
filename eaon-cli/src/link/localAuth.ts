// Reads Eaon Desktop's own locally-stored credentials (the Aqua API key and
// BYOK custom providers) straight out of macOS UserDefaults — no network
// call, no backend. This is what makes `/link` honest: the CLI and the Mac
// app run on the SAME machine, so there's real data sitting right there to
// read, rather than needing a hosted OAuth-style flow this repo has no
// backend to serve. macOS-only (UserDefaults is a macOS concept) — other
// platforms get a clear "not available here" from the caller.
//
// Extraction never touches disk: `defaults export <domain> -` and
// `plutil -extract <key> raw -o - -` are both piped through stdin/stdout
// (Node's execFileSync `input` option), so there's no intermediate
// plaintext-credential file written anywhere, not even briefly.

import { execFileSync } from "node:child_process";
import { isMac } from "../platform.js";
import type { CustomProviderConfig, CustomProviderFormat, EaonConfig } from "../types.js";

const KNOWN_FORMATS: readonly CustomProviderFormat[] = ["openAICompatible", "anthropicMessages", "googleGemini"];

/** Debug and distributed builds use different UserDefaults domains (see
 * UserDefaults domain split in the Mac app's own docs) — dist checked
 * first since that's what a real end user is running, and its Aqua key
 * wins if both domains somehow have one. BOTH are scanned and merged
 * (see discoverDesktopCredentials) — a real user can easily have run both
 * builds at different times with different custom providers saved under
 * each, and only checking the first domain that has ANYTHING silently
 * hides the other one's data entirely, exactly the "only Aqua shows up"
 * bug this was written to fix. */
const DESKTOP_DOMAINS = ["dev.eaon.desktop", "Eaon-desktop"];
const DOMAIN_LABEL: Record<string, string> = { "dev.eaon.desktop": "release build", "Eaon-desktop": "debug build" };

/** A single `defaults export <domain> -` on a real machine has been
 * observed at 4-9MB (Eaon Desktop caches plenty else in UserDefaults
 * beyond the one key this actually wants) — Node's execFileSync defaults
 * to a 1MB output buffer and throws ENOBUFS past that, silently caught by
 * the try/catch below and mistaken for "no custom providers saved". This
 * is the actual, confirmed (not guessed) root cause of that bug — real
 * data, real repro, real fix, not a hypothesis. Generous headroom above
 * observed sizes rather than just clearing the current bar. */
const MAX_DEFAULTS_EXPORT_BYTES = 200 * 1024 * 1024;

const AQUA_KEY_DEFAULTS_KEY = "api_key_eaon-api-key";
const CUSTOM_PROVIDERS_DEFAULTS_KEY = "aqua_custom_providers";

interface RawCustomProviderConfig {
  id: string;
  brand?: string;
  baseURL: string;
  format: "openAICompatible" | "anthropicMessages" | "googleGemini" | string;
  modelIDs: string[];
  customName?: string | null;
}

export interface DiscoveredCustomProvider {
  id: string;
  displayName: string;
  baseURL: string;
  modelIDs: string[];
  apiKey: string | null;
  format: CustomProviderFormat;
  /** Which UserDefaults domain this was actually read from — a real user
   * can have the same-named connection saved separately under both the
   * debug and release builds (different ids, so both surface as distinct
   * entries); the browser page uses this to tell them apart when their
   * display names collide, instead of showing two identical-looking rows. */
  sourceDomain: string;
}

export interface DiscoveryResult {
  /** Which UserDefaults domain the data came from, or null if neither had
   * anything — shown to the user so "found nothing" is explainable. */
  domain: string | null;
  aquaApiKey: string | null;
  customProviders: DiscoveredCustomProvider[];
  /** A saved connection whose `format` string wasn't one of the three the
   * Mac app itself knows how to save — genuinely unrecognized data, not
   * merely a format the CLI used to lack support for (the CLI now speaks
   * all three the Mac app does). Counted, not silently dropped, so /link
   * can say honestly what it skipped instead of just importing fewer than
   * expected with no explanation. */
  skippedUnrecognizedFormat: number;
}

function defaultsReadString(domain: string, key: string): string | null {
  try {
    const out = execFileSync("defaults", ["read", domain, key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function defaultsReadDataAsJSON<T>(domain: string, key: string): T | null {
  try {
    const exported = execFileSync("defaults", ["export", domain, "-"], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: MAX_DEFAULTS_EXPORT_BYTES });
    const b64 = execFileSync("plutil", ["-extract", key, "raw", "-o", "-", "-"], {
      input: exported,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: MAX_DEFAULTS_EXPORT_BYTES,
    }).trim();
    if (!b64) return null;
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function hasAnyDomainData(domain: string): boolean {
  try {
    execFileSync("defaults", ["read", domain], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

export function isLocalDiscoveryAvailable(): boolean {
  return isMac;
}

/** Human label for a raw UserDefaults domain — used to disambiguate two
 * discovered providers that happen to share a display name but came from
 * different Eaon Desktop builds (see DiscoveredCustomProvider.sourceDomain). */
export function domainLabel(domain: string): string {
  return DOMAIN_LABEL[domain] ?? domain;
}

/** Discovers Eaon Desktop's saved Aqua key and BYOK providers on this same
 * Mac — scans and MERGES every domain that has data, rather than stopping
 * at the first one, so running both the debug and release builds at
 * different times (a completely normal thing to do during development)
 * doesn't silently hide whichever one wasn't checked first. Returns empty
 * results (not an error) when nothing is found anywhere — that's a
 * legitimate outcome the caller shows plainly rather than a failure. */
export function discoverDesktopCredentials(): DiscoveryResult {
  if (!isMac) {
    return { domain: null, aquaApiKey: null, customProviders: [], skippedUnrecognizedFormat: 0 };
  }

  let aquaApiKey: string | null = null;
  const customProviders: DiscoveredCustomProvider[] = [];
  const seenProviderIds = new Set<string>();
  const contributingDomains: string[] = [];
  let skipped = 0;

  for (const domain of DESKTOP_DOMAINS) {
    if (!hasAnyDomainData(domain)) continue;

    const domainAquaKey = defaultsReadString(domain, AQUA_KEY_DEFAULTS_KEY);
    const rawConfigs = defaultsReadDataAsJSON<RawCustomProviderConfig[]>(domain, CUSTOM_PROVIDERS_DEFAULTS_KEY) ?? [];

    let contributed = false;
    if (domainAquaKey && !aquaApiKey) {
      aquaApiKey = domainAquaKey;
      contributed = true;
    }

    for (const raw of rawConfigs) {
      if (!(KNOWN_FORMATS as readonly string[]).includes(raw.format)) {
        skipped++;
        contributed = true;
        continue;
      }
      // The exact same connection can genuinely exist under both domains
      // (id is its real identity) — first domain that has it wins that
      // entry rather than listing it twice.
      if (seenProviderIds.has(raw.id)) continue;
      seenProviderIds.add(raw.id);
      const apiKey = defaultsReadString(domain, `api_key_custom-provider-${raw.id}`);
      const displayName = (raw.customName && raw.customName.trim().length > 0) ? raw.customName.trim() : (raw.brand ?? "Custom provider");
      customProviders.push({
        id: raw.id,
        displayName,
        baseURL: raw.baseURL,
        modelIDs: Array.isArray(raw.modelIDs) ? raw.modelIDs.filter((m) => typeof m === "string" && m.trim().length > 0) : [],
        apiKey,
        format: raw.format as CustomProviderFormat,
        sourceDomain: domain,
      });
      contributed = true;
    }

    if (contributed) contributingDomains.push(domain);
  }

  if (!aquaApiKey && customProviders.length === 0 && skipped === 0) {
    return { domain: null, aquaApiKey: null, customProviders: [], skippedUnrecognizedFormat: 0 };
  }
  return {
    domain: contributingDomains.map((d) => DOMAIN_LABEL[d] ?? d).join(" + "),
    aquaApiKey,
    customProviders,
    skippedUnrecognizedFormat: skipped,
  };
}

/** What the user actually picked on the browser confirmation page — /link
 * shows every discovered item as its own checkbox (default checked, so the
 * old "import everything" behavior is one click away), and this is what
 * they submitted. */
export interface LinkSelection {
  includeAquaKey: boolean;
  selectedProviderIds: string[];
}

/** Selects everything discovered — the pre-picker default, and still what
 * a plain programmatic caller (not the browser form) means by "link". */
export function selectAll(discovery: DiscoveryResult): LinkSelection {
  return { includeAquaKey: !!discovery.aquaApiKey, selectedProviderIds: discovery.customProviders.map((p) => p.id) };
}

/** Merges the SELECTED subset of discovered credentials into a config —
 * updates an existing custom provider by id (in case /link is re-run after
 * the desktop app's key rotated) rather than duplicating it, and leaves
 * fields untouched when nothing was discovered/selected for them (an empty
 * or deselected Aqua result never blanks out a key the user already had
 * configured directly in the CLI). */
export function applyDiscoveryToConfig(config: EaonConfig, discovery: DiscoveryResult, selection: LinkSelection): EaonConfig {
  const next: EaonConfig = { ...config, customProviders: [...config.customProviders] };
  if (selection.includeAquaKey && discovery.aquaApiKey) next.aquaApiKey = discovery.aquaApiKey;

  for (const found of discovery.customProviders) {
    if (!selection.selectedProviderIds.includes(found.id)) continue;
    const entry = { id: found.id, displayName: found.displayName, baseURL: found.baseURL, apiKey: found.apiKey ?? "", modelIDs: found.modelIDs, format: found.format };
    const existingIndex = next.customProviders.findIndex((c) => c.id === found.id);
    if (existingIndex >= 0) next.customProviders[existingIndex] = entry;
    else next.customProviders.push(entry);
  }
  return next;
}

/** Applies a browser "Set / edit keys" submission — updates Aqua key,
 * Ollama URL, upserts providers (including edits to base URL / key /
 * models / format), and removes any marked for deletion. Empty Aqua key
 * fields leave the existing value alone unless clearAquaKey is set. */
export function applyConfigureToConfig(
  config: EaonConfig,
  patch: {
    aquaApiKey: string | null;
    clearAquaKey: boolean;
    ollamaBaseUrl: string | null;
    upsertProviders: CustomProviderConfig[];
    deleteProviderIds: string[];
  }
): EaonConfig {
  const next: EaonConfig = { ...config, customProviders: [...config.customProviders] };
  if (patch.clearAquaKey) next.aquaApiKey = "";
  else if (patch.aquaApiKey) next.aquaApiKey = patch.aquaApiKey;
  if (patch.ollamaBaseUrl) next.ollamaBaseUrl = patch.ollamaBaseUrl;

  const deleteSet = new Set(patch.deleteProviderIds);
  next.customProviders = next.customProviders.filter((p) => !deleteSet.has(p.id));

  for (const entry of patch.upsertProviders) {
    if (deleteSet.has(entry.id)) continue;
    const existingIndex = next.customProviders.findIndex((c) => c.id === entry.id);
    if (existingIndex >= 0) next.customProviders[existingIndex] = entry;
    else next.customProviders.push(entry);
  }
  return next;
}
