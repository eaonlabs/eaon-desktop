// Browser HTML for `/link` — styled to match eaon.dev's design system.
// Kept separate from server.ts so HTTP handlers stay free of markup.

import { domainLabel } from "./localAuth.js";
import { PROVIDER_PRESETS } from "./providerPresets.js";
import type { DiscoveryResult } from "./localAuth.js";
import type { CustomProviderConfig, EaonConfig } from "../types.js";

/** Minimal selection shape for approved-page summaries — avoids importing
 * LinkFlowResult from server.ts (circular). */
export interface LinkPageSelection {
  approved: boolean;
  mode: "import" | "configure" | "none";
  includeAquaKey: boolean;
  selectedProviderIds: string[];
  aquaApiKey: string | null;
  clearAquaKey: boolean;
  ollamaBaseUrl: string | null;
  upsertProviders: Array<{ id: string; displayName: string }>;
  deleteProviderIds: string[];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function maskKey(key: string): string {
  const t = key.trim();
  if (t.length === 0) return "(not set)";
  if (t.length <= 8) return "••••••••";
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

interface PickableRow {
  checkName: string | null;
  label: string;
}

function pickableRows(discovery: DiscoveryResult): PickableRow[] {
  const rows: PickableRow[] = [
    discovery.aquaApiKey
      ? { checkName: "aqua", label: "Eaon API key" }
      : { checkName: null, label: "No Eaon API key found on this Mac" },
  ];
  const nameCounts = new Map<string, number>();
  for (const p of discovery.customProviders) nameCounts.set(p.displayName, (nameCounts.get(p.displayName) ?? 0) + 1);
  for (const p of discovery.customProviders) {
    const suffix = (nameCounts.get(p.displayName) ?? 0) > 1 ? ` (${domainLabel(p.sourceDomain)})` : "";
    rows.push({ checkName: `provider_${p.id}`, label: `Custom provider — ${p.displayName}${suffix}` });
  }
  if (discovery.skippedUnrecognizedFormat > 0) {
    rows.push({
      checkName: null,
      label: `${discovery.skippedUnrecognizedFormat} provider${discovery.skippedUnrecognizedFormat === 1 ? "" : "s"} skipped (unrecognized format)`,
    });
  }
  return rows;
}

const BRAND_MARK = `<svg class="brand-mark" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" fill="#F1704F"/><path d="M50 24 L78 74 C64 60 36 60 22 74 Z" fill="#fff"/></svg>`;

function existingProviderRow(p: CustomProviderConfig): string {
  const format = p.format ?? "openAICompatible";
  const modelCount = p.modelIDs.length;
  const modelLabel = `${modelCount} model${modelCount === 1 ? "" : "s"}`;
  return `
    <details class="provider-row">
      <summary>
        <span class="provider-summary-main">
          <strong>${escapeHtml(p.displayName)}</strong>
          <span class="meta">${escapeHtml(modelLabel)} · ${escapeHtml(maskKey(p.apiKey))}</span>
        </span>
        <span class="chev" aria-hidden="true">›</span>
      </summary>
      <div class="provider-body">
        <input type="hidden" name="existing_id" value="${escapeHtml(p.id)}">
        <label class="field">Name
          <input name="name_${escapeHtml(p.id)}" value="${escapeHtml(p.displayName)}" required>
        </label>
        <label class="field">API key <span class="hint">blank keeps ${escapeHtml(maskKey(p.apiKey))}</span>
          <input name="key_${escapeHtml(p.id)}" type="password" autocomplete="off" placeholder="••••••••">
        </label>
        <label class="field">Models <span class="hint">one per line</span>
          <textarea name="models_${escapeHtml(p.id)}" rows="3">${escapeHtml(p.modelIDs.join("\n"))}</textarea>
        </label>
        <label class="check-inline delete-row"><input type="checkbox" name="delete_${escapeHtml(p.id)}"> Remove this provider</label>
        <details class="advanced">
          <summary>Advanced settings</summary>
          <label class="field">Server address (base URL)
            <input name="base_${escapeHtml(p.id)}" value="${escapeHtml(p.baseURL)}" required>
          </label>
          <label class="field">Request format
            <select name="format_${escapeHtml(p.id)}">
              <option value="openAICompatible" ${format === "openAICompatible" ? "selected" : ""}>Standard (OpenAI-style)</option>
              <option value="anthropicMessages" ${format === "anthropicMessages" ? "selected" : ""}>Anthropic (Claude)</option>
              <option value="googleGemini" ${format === "googleGemini" ? "selected" : ""}>Google (Gemini)</option>
            </select>
          </label>
        </details>
      </div>
    </details>`;
}

function addProviderFormHtml(): string {
  const options = PROVIDER_PRESETS.map(
    (p) =>
      `<option value="${escapeHtml(p.id)}" data-base="${escapeHtml(p.baseURL)}" data-format="${escapeHtml(p.format)}" data-example="${escapeHtml(p.exampleModelID)}" data-note="${escapeHtml(p.autoSetupNote)}">${escapeHtml(p.name)}</option>`
  ).join("");

  return `
    <section class="block">
      <h2 class="section">Add custom provider</h2>
      <p class="sub">Pick a company, paste your key, fetch models.</p>

      <label class="field">Provider
        <select id="new_brand" name="new_brand">${options}</select>
      </label>
      <p class="auto-note" id="brand_note"><span class="check">✓</span> Connection details for OpenAI are set up automatically.</p>

      <label class="field">Name <span class="hint">(optional)</span>
        <input id="new_name" name="new_name" placeholder="OpenAI">
      </label>

      <label class="field">API key
        <input id="new_key" name="new_key" type="password" autocomplete="off" placeholder="Paste your OpenAI API key">
      </label>
      <p class="help" id="key_help">From your provider account. Stays on this device.</p>

      <div class="models-head">
        <span class="field-label">Models</span>
        <button type="button" class="fetch-btn" id="fetch_models">Fetch</button>
      </div>
      <textarea id="new_models" name="new_models" rows="4" placeholder="gpt-4o"></textarea>
      <p class="help">Fetched from your key, or type one model per line.</p>
      <p class="fetch-status" id="fetch_status" hidden></p>

      <details class="advanced" id="advanced_new">
        <summary>Advanced settings</summary>
        <p class="help">Defaults work for most providers.</p>
        <label class="field">Server address (base URL)
          <input id="new_base" name="new_base" value="https://api.openai.com/v1" placeholder="https://api.example.com/v1">
        </label>
        <label class="field">Request format
          <select id="new_format" name="new_format">
            <option value="openAICompatible">Standard (OpenAI-style)</option>
            <option value="anthropicMessages">Anthropic (Claude)</option>
            <option value="googleGemini">Google (Gemini)</option>
          </select>
        </label>
      </details>
    </section>`;
}

function pageStyles(): string {
  return `
  :root {
    --bg: #101012;
    --surface: #19191c;
    --surface-2: #202024;
    --border: rgba(154,154,162,0.16);
    --text: #ededed;
    --text-2: #bcbcc4;
    --text-3: #9a9aa2;
    --coral: #f1704f;
    --coral-bright: #ff8768;
    --ink: #101012;
    --ok: #6bcf8e;
    --err: #ff6467;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: "Switzer", system-ui, sans-serif;
    font-weight: 400;
    min-height: 100vh;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 48px 20px 64px;
    -webkit-font-smoothing: antialiased;
  }
  .shell {
    width: 100%;
    max-width: 440px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 28px;
  }
  .brand-mark {
    width: 28px;
    height: 28px;
    border-radius: 4px;
    display: block;
    flex: none;
  }
  .brand-word {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-2);
  }
  .eyebrow {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-3);
    margin: 0 0 10px;
  }
  h1 {
    font-size: 28px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.15;
    margin: 0 0 10px;
    color: var(--text);
  }
  h1 .squig {
    font-family: "Instrument Serif", Georgia, serif;
    font-style: italic;
    font-weight: 400;
    color: var(--coral);
  }
  .lede {
    color: var(--text-2);
    font-size: 14.5px;
    line-height: 1.55;
    margin: 0 0 28px;
  }
  .tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    margin: 0 0 28px;
  }
  .tab {
    flex: 1;
    padding: 10px 8px 12px;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    background: transparent;
    color: var(--text-3);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.02em;
    cursor: pointer;
  }
  .tab.active {
    color: var(--text);
    border-bottom-color: var(--coral);
  }
  .tab:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .panel { display: none; }
  .panel.active { display: block; }
  .section {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-3);
    margin: 0 0 14px;
  }
  .block {
    padding: 28px 0 0;
    border-top: 1px solid var(--border);
    margin-top: 28px;
  }
  .block:first-child { border-top: none; margin-top: 0; padding-top: 0; }
  .sub {
    color: var(--text-3);
    font-size: 13px;
    line-height: 1.45;
    margin: -6px 0 18px;
  }
  .muted {
    color: var(--text-2);
    font-size: 14px;
    line-height: 1.55;
    margin: 0 0 16px;
  }
  .help {
    color: var(--text-3);
    font-size: 12.5px;
    line-height: 1.45;
    margin: -4px 0 16px;
  }
  .auto-note {
    color: var(--text-3);
    font-size: 12.5px;
    line-height: 1.45;
    margin: -4px 0 16px;
  }
  .auto-note .check { color: var(--ok); margin-right: 4px; }
  .rows {
    border-top: 1px solid var(--border);
    margin-bottom: 16px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 0;
    border-bottom: 1px solid var(--border);
  }
  .row-checkable { cursor: pointer; }
  .row-check {
    flex: none;
    width: 16px;
    height: 16px;
    accent-color: var(--coral);
  }
  .row-label { font-size: 14px; color: var(--text); }
  .badge {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 600;
    background: var(--surface-2);
    color: var(--text-3);
  }
  .badge-ok { background: rgba(107, 207, 142, 0.12); color: var(--ok); }
  .select-toggle {
    margin: 0 0 24px;
    font-size: 12.5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  .select-toggle a { color: var(--text-3); text-decoration: none; }
  .select-toggle a:hover { color: var(--text); }
  .select-toggle .dot { margin: 0 8px; color: var(--border); }
  .field {
    display: block;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--text-2);
    margin-bottom: 14px;
  }
  .field-label {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--text-2);
  }
  .hint { font-weight: 400; color: var(--text-3); }
  .field input, .field select, textarea {
    display: block;
    width: 100%;
    margin-top: 7px;
    padding: 10px 12px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 14px;
    font-family: inherit;
  }
  textarea {
    resize: vertical;
    line-height: 1.45;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 14px;
    font-family: inherit;
    width: 100%;
    padding: 10px 12px;
  }
  .field input:focus, .field select:focus, textarea:focus {
    outline: none;
    border-color: rgba(241, 112, 79, 0.55);
  }
  .check-inline {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-3);
    font-size: 13px;
    margin: -2px 0 16px;
  }
  .check-inline input { accent-color: var(--coral); }
  .provider-list {
    border-top: 1px solid var(--border);
    margin-bottom: 8px;
  }
  .provider-row {
    border-bottom: 1px solid var(--border);
  }
  .provider-row > summary {
    list-style: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 0;
    cursor: pointer;
  }
  .provider-row > summary::-webkit-details-marker { display: none; }
  .provider-summary-main {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .provider-summary-main strong {
    font-size: 14px;
    font-weight: 550;
    color: var(--text);
  }
  .provider-summary-main .meta {
    font-size: 12px;
    color: var(--text-3);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  .chev {
    color: var(--text-3);
    font-size: 16px;
    transform: rotate(90deg);
    transition: transform 0.15s ease;
    flex: none;
  }
  .provider-row[open] > summary .chev { transform: rotate(-90deg); }
  .provider-body {
    padding: 0 0 18px;
  }
  .delete-row { color: var(--text-3); }
  .models-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 7px;
  }
  .fetch-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-2);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 5px 10px;
    border-radius: 3px;
    cursor: pointer;
  }
  .fetch-btn:hover { color: var(--text); border-color: var(--text-3); }
  .fetch-status { font-size: 12.5px; margin: 8px 0 12px; color: var(--text-3); }
  .fetch-status.err { color: var(--err); }
  .fetch-status.ok { color: var(--ok); }
  details.advanced {
    margin: 4px 0 8px;
  }
  details.advanced > summary {
    cursor: pointer;
    color: var(--text-3);
    font-size: 12.5px;
    font-weight: 500;
    margin-bottom: 12px;
    list-style: none;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  details.advanced > summary::-webkit-details-marker { display: none; }
  details.advanced > summary::before {
    content: "› ";
    display: inline-block;
    transform: rotate(90deg);
    margin-right: 2px;
  }
  details.advanced[open] > summary::before { transform: rotate(-90deg); }
  .actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    margin-top: 32px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
  }
  button.primary, button.secondary {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 11px 18px;
    border-radius: 4px;
    border: none;
    cursor: pointer;
  }
  button.primary {
    background: var(--coral);
    color: var(--ink);
  }
  button.primary:hover { background: var(--coral-bright); }
  button.secondary {
    background: transparent;
    color: var(--text-2);
    border: 1px solid var(--border);
  }
  button.secondary:hover { color: var(--text); border-color: var(--text-3); }
  .footnote {
    margin: 28px 0 0;
    font-size: 12px;
    color: var(--text-3);
    text-align: center;
    line-height: 1.45;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    background: var(--surface-2);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 12px;
  }
  .status-wrap {
    text-align: center;
    padding: 24px 0 8px;
  }
  .status-mark {
    width: 40px;
    height: 40px;
    border-radius: 4px;
    margin: 0 auto 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    font-weight: 600;
    background: var(--surface-2);
    color: var(--text-3);
  }
  .status-mark.ok {
    background: rgba(107, 207, 142, 0.12);
    color: var(--ok);
  }
  .status-wrap h1 {
    font-size: 24px;
    margin-bottom: 12px;
  }
  .status-wrap .muted {
    text-align: center;
  }
  .status-wrap .rows {
    text-align: left;
    margin: 20px 0;
  }
`;
}

function pageScript(): string {
  return `
<script>
  function showTab(name) {
    document.querySelectorAll('.tab').forEach(function(t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === name && !t.disabled);
    });
    document.querySelectorAll('.panel').forEach(function(p) {
      p.classList.toggle('active', p.id === 'panel-' + name);
    });
  }

  function applyBrand() {
    var sel = document.getElementById('new_brand');
    if (!sel) return;
    var opt = sel.options[sel.selectedIndex];
    var name = opt.textContent;
    var base = opt.getAttribute('data-base') || '';
    var format = opt.getAttribute('data-format') || 'openAICompatible';
    var example = opt.getAttribute('data-example') || '';
    var note = opt.getAttribute('data-note') || '';
    var nameInput = document.getElementById('new_name');
    var baseInput = document.getElementById('new_base');
    var formatInput = document.getElementById('new_format');
    var models = document.getElementById('new_models');
    var keyInput = document.getElementById('new_key');
    var noteEl = document.getElementById('brand_note');
    var keyHelp = document.getElementById('key_help');
    if (nameInput && !nameInput.value) nameInput.placeholder = name;
    if (baseInput) baseInput.value = base;
    if (formatInput) formatInput.value = format;
    if (models && !models.value.trim()) models.placeholder = example;
    if (keyInput) keyInput.placeholder = 'Paste your ' + name + ' API key';
    if (noteEl) noteEl.innerHTML = '<span class="check">✓</span> ' + note;
    if (keyHelp) keyHelp.textContent = 'From your ' + name + ' account. Stays on this device.';
    var adv = document.getElementById('advanced_new');
    if (adv && sel.value === 'custom') adv.open = true;
  }

  async function fetchModels() {
    var status = document.getElementById('fetch_status');
    var key = (document.getElementById('new_key').value || '').trim();
    var base = (document.getElementById('new_base').value || '').trim();
    var format = document.getElementById('new_format').value;
    if (!key) {
      status.hidden = false;
      status.className = 'fetch-status err';
      status.textContent = 'Paste an API key first.';
      return;
    }
    if (!base) {
      status.hidden = false;
      status.className = 'fetch-status err';
      status.textContent = 'Set a base URL in Advanced settings.';
      return;
    }
    status.hidden = false;
    status.className = 'fetch-status';
    status.textContent = 'Fetching models…';
    try {
      var res = await fetch('/fetch-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseURL: base, apiKey: key, format: format })
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Fetch failed');
      var ids = data.models || [];
      if (ids.length === 0) {
        status.className = 'fetch-status err';
        status.textContent = 'No models returned — type them in manually.';
        return;
      }
      document.getElementById('new_models').value = ids.join('\\n');
      status.className = 'fetch-status ok';
      status.textContent = 'Loaded ' + ids.length + ' model' + (ids.length === 1 ? '' : 's') + '.';
    } catch (e) {
      status.className = 'fetch-status err';
      status.textContent = e.message || String(e);
    }
  }

  document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('.tab').forEach(function(t) {
      t.addEventListener('click', function() {
        if (t.disabled) return;
        showTab(t.getAttribute('data-tab'));
      });
    });
    var brand = document.getElementById('new_brand');
    if (brand) {
      brand.addEventListener('change', applyBrand);
      applyBrand();
    }
    var fetchBtn = document.getElementById('fetch_models');
    if (fetchBtn) fetchBtn.addEventListener('click', fetchModels);
  });
</script>`;
}

function brandRow(): string {
  return `<div class="brand">${BRAND_MARK}<span class="brand-word">Eaon</span></div>`;
}

function approvedSummaryHtml(
  discovery: DiscoveryResult,
  config: EaonConfig,
  selection: LinkPageSelection
): string {
  if (!selection.approved) return "";
  if (selection.mode === "import") {
    const bits: string[] = [];
    if (selection.includeAquaKey) bits.push("Eaon API key");
    for (const id of selection.selectedProviderIds) {
      const p = discovery.customProviders.find((c) => c.id === id);
      bits.push(p ? `Provider · ${p.displayName}` : `Provider · ${id}`);
    }
    if (bits.length === 0) return `<p class="muted">Nothing was selected.</p>`;
    return `<div class="rows">${bits.map((b) => `<div class="row"><span class="badge badge-ok">✓</span><span class="row-label">${escapeHtml(b)}</span></div>`).join("")}</div>`;
  }
  if (selection.mode === "configure") {
    const bits: string[] = [];
    if (selection.clearAquaKey) bits.push("Cleared Eaon API key");
    else if (selection.aquaApiKey) bits.push("Updated Eaon API key");
    if (selection.ollamaBaseUrl) bits.push(`Ollama URL · ${selection.ollamaBaseUrl}`);
    for (const p of selection.upsertProviders) bits.push(`Saved · ${p.displayName}`);
    for (const id of selection.deleteProviderIds) {
      const existing = config.customProviders.find((c) => c.id === id);
      bits.push(`Removed · ${existing?.displayName ?? id}`);
    }
    if (bits.length === 0) return `<p class="muted">No changes submitted.</p>`;
    return `<div class="rows">${bits.map((b) => `<div class="row"><span class="badge badge-ok">✓</span><span class="row-label">${escapeHtml(b)}</span></div>`).join("")}</div>`;
  }
  return "";
}

function renderPending(discovery: DiscoveryResult, config: EaonConfig): string {
  const hasDesktop = !!(discovery.domain && (discovery.aquaApiKey || discovery.customProviders.length > 0));
  const rows = pickableRows(discovery);
  const anySelectable = rows.some((r) => r.checkName !== null);
  const defaultTab = hasDesktop ? "import" : "configure";

  const pendingRowsHtml = rows
    .map((row) =>
      row.checkName
        ? `<label class="row row-checkable"><input type="checkbox" name="${row.checkName}" class="row-check" checked><span class="row-label">${escapeHtml(row.label)}</span></label>`
        : `<div class="row"><span class="badge">–</span><span class="row-label">${escapeHtml(row.label)}</span></div>`
    )
    .join("");

  const existingEditors =
    config.customProviders.length > 0
      ? `<div class="provider-list">${config.customProviders.map(existingProviderRow).join("")}</div>`
      : `<p class="sub">None yet — add one below.</p>`;

  return `
    ${brandRow()}
    <p class="eyebrow">CLI setup</p>
    <h1>Set up <span class="squig">Eaon</span></h1>
    <p class="lede">Import from Desktop, or add API keys for hosted models and BYOK providers.</p>

    <div class="tabs">
      <button type="button" class="tab ${defaultTab === "import" ? "active" : ""}" data-tab="import" ${hasDesktop ? "" : "disabled"}>Import</button>
      <button type="button" class="tab ${defaultTab === "configure" ? "active" : ""}" data-tab="configure">Set / edit keys</button>
    </div>

    <div class="panel ${defaultTab === "import" ? "active" : ""}" id="panel-import">
      ${
        hasDesktop
          ? `<form method="POST" action="/approve">
        <p class="muted">Credentials from Eaon Desktop${discovery.domain ? ` (${escapeHtml(discovery.domain)})` : ""}.</p>
        <div class="rows">${pendingRowsHtml}</div>
        ${
          anySelectable
            ? `<div class="select-toggle"><a href="#" onclick="document.querySelectorAll('#panel-import .row-check').forEach(c=>c.checked=true);return false;">Select all</a><span class="dot">·</span><a href="#" onclick="document.querySelectorAll('#panel-import .row-check').forEach(c=>c.checked=false);return false;">Select none</a></div>`
            : ""
        }
        <div class="actions">
          <button class="secondary" type="submit" formaction="/cancel">Cancel</button>
          <button class="primary" type="submit">Import selected</button>
        </div>
      </form>`
          : `<p class="muted">No Desktop credentials found. Switch to Set / edit keys to add an Eaon API key or custom provider.</p>
             <div class="actions"><button class="secondary" type="button" onclick="showTab('configure')">Set / edit keys</button></div>`
      }
    </div>

    <div class="panel ${defaultTab === "configure" ? "active" : ""}" id="panel-configure">
      <form method="POST" action="/configure">
        <section class="block">
          <h2 class="section">Eaon hosted</h2>
          <label class="field">Eaon API key <span class="hint">currently ${escapeHtml(maskKey(config.aquaApiKey))}</span>
            <input name="aqua_key" type="password" autocomplete="off" placeholder="sk-eaon-… or leave blank to keep">
          </label>
          <label class="check-inline"><input type="checkbox" name="clear_aqua"> Clear Eaon key</label>
        </section>

        <section class="block">
          <h2 class="section">Ollama</h2>
          <label class="field">Base URL
            <input name="ollama_url" value="${escapeHtml(config.ollamaBaseUrl)}" placeholder="http://127.0.0.1:11434">
          </label>
        </section>

        <section class="block">
          <h2 class="section">Your providers</h2>
          ${existingEditors}
        </section>

        ${addProviderFormHtml()}

        <div class="actions">
          <button class="secondary" type="submit" formaction="/cancel">Cancel</button>
          <button class="primary" type="submit">Save</button>
        </div>
      </form>
    </div>

    <p class="footnote">Local only · 127.0.0.1 — nothing leaves this machine.</p>
  `;
}

function renderStatus(
  discovery: DiscoveryResult,
  config: EaonConfig,
  opts: { state: "approved" | "cancelled" | "expired"; selection?: LinkPageSelection }
): string {
  if (opts.state === "cancelled") {
    return `
      ${brandRow()}
      <div class="status-wrap">
        <div class="status-mark">–</div>
        <h1>Cancelled</h1>
        <p class="muted">Nothing was changed. You can close this tab.</p>
      </div>`;
  }
  if (opts.state === "expired") {
    return `
      ${brandRow()}
      <div class="status-wrap">
        <div class="status-mark">⏱</div>
        <h1>Link expired</h1>
        <p class="muted">Run <code>/link</code> again in the CLI to retry.</p>
      </div>`;
  }

  const selection = opts.selection;
  const nothingChanged =
    !!selection &&
    selection.approved &&
    ((selection.mode === "import" && !selection.includeAquaKey && selection.selectedProviderIds.length === 0) ||
      (selection.mode === "configure" &&
        !selection.aquaApiKey &&
        !selection.clearAquaKey &&
        !selection.ollamaBaseUrl &&
        selection.upsertProviders.length === 0 &&
        selection.deleteProviderIds.length === 0));

  if (nothingChanged) {
    return `
      ${brandRow()}
      <div class="status-wrap">
        <div class="status-mark">–</div>
        <h1>Nothing saved</h1>
        <p class="muted">No changes were submitted. You can close this tab.</p>
      </div>`;
  }

  return `
    ${brandRow()}
    <div class="status-wrap">
      <div class="status-mark ok">✓</div>
      <h1>Saved</h1>
      ${selection ? approvedSummaryHtml(discovery, config, selection) : ""}
      <p class="muted">You can close this tab and return to your terminal.</p>
    </div>`;
}

export function renderLinkPage(
  discovery: DiscoveryResult,
  config: EaonConfig,
  opts: { state: "pending" | "approved" | "cancelled" | "expired"; selection?: LinkPageSelection }
): string {
  const body =
    opts.state === "pending"
      ? renderPending(discovery, config)
      : renderStatus(discovery, config, { state: opts.state, selection: opts.selection });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up Eaon CLI</title>
<link rel="preconnect" href="https://api.fontshare.com" />
<link href="https://api.fontshare.com/v2/css?f[]=switzer@400,500,600,700&display=swap" rel="stylesheet" />
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@1&display=swap" rel="stylesheet" />
<style>${pageStyles()}</style>
${opts.state === "pending" ? pageScript() : ""}
</head>
<body><div class="shell">${body}</div></body>
</html>`;
}
