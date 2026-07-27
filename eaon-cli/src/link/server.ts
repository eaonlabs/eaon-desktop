// The browser half of /link: a real local HTTP server (127.0.0.1 only)
// that opens in the user's default browser. Two paths on one page:
//   1. Import — pick credentials discovered from Eaon Desktop (macOS)
//   2. Configure — Eaon API key + BYOK providers matching Desktop's
//      "Add Custom Provider" form (provider presets, fetch models,
//      advanced base URL / format)
// Nothing is written to the CLI config until the user submits a form.

import http from "node:http";
import { randomUUID } from "node:crypto";
import { presetById } from "./providerPresets.js";
import { renderLinkPage } from "./page.js";
import type { DiscoveryResult } from "./localAuth.js";
import type { CustomProviderConfig, CustomProviderFormat, EaonConfig } from "../types.js";

export interface LinkFlowResult {
  approved: boolean;
  timedOut: boolean;
  mode: "import" | "configure" | "none";
  includeAquaKey: boolean;
  selectedProviderIds: string[];
  aquaApiKey: string | null;
  clearAquaKey: boolean;
  ollamaBaseUrl: string | null;
  upsertProviders: CustomProviderConfig[];
  deleteProviderIds: string[];
}

const TIMEOUT_MS = 5 * 60_000;
const KNOWN_FORMATS: readonly CustomProviderFormat[] = ["openAICompatible", "anthropicMessages", "googleGemini"];

function emptyResult(partial: Partial<LinkFlowResult> & Pick<LinkFlowResult, "approved" | "timedOut" | "mode">): LinkFlowResult {
  return {
    includeAquaKey: false,
    selectedProviderIds: [],
    aquaApiKey: null,
    clearAquaKey: false,
    ollamaBaseUrl: null,
    upsertProviders: [],
    deleteProviderIds: [],
    ...partial,
  };
}

function parseFormat(raw: string | null): CustomProviderFormat {
  if (raw && (KNOWN_FORMATS as readonly string[]).includes(raw)) return raw as CustomProviderFormat;
  return "openAICompatible";
}

function parseModelIds(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseImportSelection(body: string, discovery: DiscoveryResult): Pick<LinkFlowResult, "includeAquaKey" | "selectedProviderIds"> {
  const params = new URLSearchParams(body);
  return {
    includeAquaKey: !!discovery.aquaApiKey && params.has("aqua"),
    selectedProviderIds: discovery.customProviders.filter((p) => params.has(`provider_${p.id}`)).map((p) => p.id),
  };
}

function parseConfigure(body: string, config: EaonConfig): Pick<
  LinkFlowResult,
  "aquaApiKey" | "clearAquaKey" | "ollamaBaseUrl" | "upsertProviders" | "deleteProviderIds"
> {
  const params = new URLSearchParams(body);
  const clearAquaKey = params.has("clear_aqua");
  const aquaRaw = (params.get("aqua_key") ?? "").trim();
  const aquaApiKey = !clearAquaKey && aquaRaw.length > 0 ? aquaRaw : null;

  const ollamaRaw = (params.get("ollama_url") ?? "").trim();
  const ollamaBaseUrl = ollamaRaw.length > 0 && ollamaRaw !== config.ollamaBaseUrl ? ollamaRaw : null;

  const deleteProviderIds: string[] = [];
  const upsertProviders: CustomProviderConfig[] = [];

  for (const id of params.getAll("existing_id")) {
    if (params.has(`delete_${id}`)) {
      deleteProviderIds.push(id);
      continue;
    }
    const prev = config.customProviders.find((c) => c.id === id);
    if (!prev) continue;
    const displayName = (params.get(`name_${id}`) ?? prev.displayName).trim() || prev.displayName;
    const baseURL = (params.get(`base_${id}`) ?? prev.baseURL).trim();
    const keyRaw = (params.get(`key_${id}`) ?? "").trim();
    const apiKey = keyRaw.length > 0 ? keyRaw : prev.apiKey;
    const format = parseFormat(params.get(`format_${id}`));
    const modelIDs = parseModelIds(params.get(`models_${id}`) ?? prev.modelIDs.join("\n"));
    upsertProviders.push({ id, displayName, baseURL, apiKey, modelIDs, format });
  }

  const brandId = (params.get("new_brand") ?? "openAI").trim();
  const preset = presetById(brandId);
  const newNameRaw = (params.get("new_name") ?? "").trim();
  const newBase = (params.get("new_base") ?? "").trim() || preset.baseURL;
  const newKey = (params.get("new_key") ?? "").trim();
  const newModels = parseModelIds(params.get("new_models") ?? "");
  // Save a new provider when the user supplied a key (and we have a base URL).
  if (newKey.length > 0 && newBase.length > 0) {
    upsertProviders.push({
      id: `custom-${randomUUID()}`,
      displayName: newNameRaw || preset.name,
      baseURL: newBase,
      apiKey: newKey,
      modelIDs: newModels.length > 0 ? newModels : preset.exampleModelID ? [preset.exampleModelID] : [],
      format: parseFormat(params.get("new_format") ?? preset.format),
    });
  }

  return { aquaApiKey, clearAquaKey, ollamaBaseUrl, upsertProviders, deleteProviderIds };
}

/** Fetch model ids from a BYOK endpoint — used by the browser Fetch button. */
async function fetchProviderModels(baseURL: string, apiKey: string, format: CustomProviderFormat): Promise<string[]> {
  const base = baseURL.replace(/\/+$/, "");
  if (format === "anthropicMessages") {
    const res = await fetch(`${base}/models`, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Provider returned ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    return (json.data ?? []).map((m) => m.id).filter((id): id is string => !!id && id.trim().length > 0);
  }
  if (format === "googleGemini") {
    const url = `${base}/models?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Provider returned ${res.status}`);
    const json = (await res.json()) as { models?: Array<{ name?: string }> };
    return (json.models ?? [])
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter((id) => id.length > 0);
  }
  const res = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Provider returned ${res.status}`);
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  return (json.data ?? []).map((m) => m.id).filter((id): id is string => !!id && id.trim().length > 0);
}

export function runLinkServer(
  discovery: DiscoveryResult,
  config: EaonConfig
): { url: Promise<string>; result: Promise<LinkFlowResult> } {
  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (err: Error) => void;
  let resolveResult!: (result: LinkFlowResult) => void;
  const urlPromise = new Promise<string>((res, rej) => {
    resolveUrl = res;
    rejectUrl = rej;
  });
  const resultPromise = new Promise<LinkFlowResult>((res) => {
    resolveResult = res;
  });

  let settled = false;
  let lastSelection: LinkFlowResult | undefined;
  const finish = (result: LinkFlowResult) => {
    if (settled) return;
    settled = true;
    lastSelection = result;
    clearTimeout(timeout);
    resolveResult(result);
    setTimeout(() => server.close(), 500);
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      try {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
        if (!res.writableEnded) res.end("Internal error");
      } catch {
        // nothing more to do
      }
    });
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderLinkPage(discovery, config, { state: settled ? "expired" : "pending", selection: lastSelection }));
      return;
    }
    if (req.method === "POST" && req.url === "/fetch-models") {
      try {
        const raw = await readRequestBody(req);
        const body = JSON.parse(raw) as { baseURL?: string; apiKey?: string; format?: string };
        const baseURL = (body.baseURL ?? "").trim();
        const apiKey = (body.apiKey ?? "").trim();
        const format = parseFormat(body.format ?? null);
        if (!baseURL || !apiKey) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "baseURL and apiKey are required" }));
          return;
        }
        const models = await fetchProviderModels(baseURL, apiKey, format);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models }));
      } catch (e) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }
    if (req.method === "POST" && req.url === "/approve") {
      const selection = parseImportSelection(await readRequestBody(req), discovery);
      const result = emptyResult({ approved: true, timedOut: false, mode: "import", ...selection });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderLinkPage(discovery, config, { state: "approved", selection: result }));
      finish(result);
      return;
    }
    if (req.method === "POST" && req.url === "/configure") {
      const configured = parseConfigure(await readRequestBody(req), config);
      const result = emptyResult({ approved: true, timedOut: false, mode: "configure", ...configured });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderLinkPage(discovery, config, { state: "approved", selection: result }));
      finish(result);
      return;
    }
    if (req.method === "POST" && req.url === "/cancel") {
      const result = emptyResult({ approved: false, timedOut: false, mode: "none" });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderLinkPage(discovery, config, { state: "cancelled" }));
      finish(result);
      return;
    }
    res.writeHead(404);
    res.end();
  }

  const timeout = setTimeout(() => finish(emptyResult({ approved: false, timedOut: true, mode: "none" })), TIMEOUT_MS);

  server.on("error", (err) => {
    clearTimeout(timeout);
    if (!settled) {
      settled = true;
      resolveResult(emptyResult({ approved: false, timedOut: false, mode: "none" }));
    }
    rejectUrl(err instanceof Error ? err : new Error(String(err)));
  });

  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    resolveUrl(`http://127.0.0.1:${port}/`);
  });

  return { url: urlPromise, result: resultPromise };
}
