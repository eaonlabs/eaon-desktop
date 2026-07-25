// The "Add Custom Provider" flow, opened from the "+" next to MODEL
// PROVIDERS in the sidebar: pick a company from a real brand-logo dropdown,
// paste a key, optionally fetch its model list, with the base URL/wire
// format tucked behind an "Advanced settings" disclosure since the presets
// cover almost everyone.

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import Button from "../../common/Button";
import Dialog from "../../common/Dialog";
import BrandLogo from "../../models/BrandLogo";
import { fetchProviderModels } from "../../../core/ipc";
import type { CustomProvider, ProviderFormat } from "../../../core/types";
import { uid } from "../../../core/utils";
import { EAON_PROVIDER_ID, useUi } from "../../../state/ui";
import { useSettings } from "../../../state/settings";

interface Preset {
  name: string;
  baseURL: string;
  format: ProviderFormat;
  /** False only for "Custom" — no known base URL to prefill. */
  automatic: boolean;
  example: string;
}

const PRESETS: Preset[] = [
  { name: "OpenAI", baseURL: "https://api.openai.com/v1", format: "openai", automatic: true, example: "gpt-4o" },
  { name: "Anthropic", baseURL: "https://api.anthropic.com/v1", format: "anthropic", automatic: true, example: "claude-sonnet-4-6" },
  { name: "Google", baseURL: "https://generativelanguage.googleapis.com/v1beta", format: "gemini", automatic: true, example: "gemini-3-pro" },
  { name: "Cerebras", baseURL: "https://api.cerebras.ai/v1", format: "openai", automatic: true, example: "llama-3.3-70b" },
  { name: "Cohere", baseURL: "https://api.cohere.com/compatibility/v1", format: "openai", automatic: true, example: "command-a" },
  { name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", format: "openai", automatic: true, example: "deepseek-chat" },
  { name: "Fireworks", baseURL: "https://api.fireworks.ai/inference/v1", format: "openai", automatic: true, example: "accounts/fireworks/models/llama-v3p1-70b" },
  { name: "Groq", baseURL: "https://api.groq.com/openai/v1", format: "openai", automatic: true, example: "llama-3.3-70b" },
  { name: "Mistral", baseURL: "https://api.mistral.ai/v1", format: "openai", automatic: true, example: "mistral-large-latest" },
  { name: "NVIDIA", baseURL: "https://integrate.api.nvidia.com/v1", format: "openai", automatic: true, example: "meta/llama-3.1-70b-instruct" },
  { name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", format: "openai", automatic: true, example: "openai/gpt-4o" },
  { name: "Perplexity", baseURL: "https://api.perplexity.ai", format: "openai", automatic: true, example: "sonar-pro" },
  { name: "Together", baseURL: "https://api.together.xyz/v1", format: "openai", automatic: true, example: "meta-llama/Llama-3.3-70B" },
  { name: "xAI", baseURL: "https://api.x.ai/v1", format: "openai", automatic: true, example: "grok-4" },
  { name: "Custom", baseURL: "", format: "openai", automatic: false, example: "model-id" },
];

const FORMAT_LABELS: Array<{ value: ProviderFormat; label: string }> = [
  { value: "openai", label: "Standard (OpenAI-style) — recommended" },
  { value: "anthropic", label: "Anthropic Messages" },
  { value: "gemini", label: "Google Gemini" },
];

export default function AddProviderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const customProviders = useSettings((s) => s.settings.customProviders);
  const update = useSettings((s) => s.update);
  const openSettings = useUi((s) => s.openSettings);

  const [preset, setPreset] = useState<Preset>(PRESETS[0]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [modelsText, setModelsText] = useState("");
  const [baseUrlDraft, setBaseUrlDraft] = useState(PRESETS[0].baseURL);
  const [formatDraft, setFormatDraft] = useState<ProviderFormat>(PRESETS[0].format);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Fresh slate every time the dialog opens, not just on first mount.
  useEffect(() => {
    if (!open) return;
    setPreset(PRESETS[0]);
    setNameDraft("");
    setApiKeyDraft("");
    setModelsText("");
    setBaseUrlDraft(PRESETS[0].baseURL);
    setFormatDraft(PRESETS[0].format);
    setAdvancedOpen(false);
    setFetchError(null);
  }, [open]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pickerOpen]);

  const choosePreset = (p: Preset) => {
    setPreset(p);
    setBaseUrlDraft(p.baseURL);
    setFormatDraft(p.format);
    setAdvancedOpen(!p.automatic);
    setPickerOpen(false);
  };

  const fetchModels = async () => {
    setFetching(true);
    setFetchError(null);
    try {
      const models = await fetchProviderModels(baseUrlDraft.trim(), apiKeyDraft.trim() || null);
      const existing = modelsText.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const m of models) if (!existing.includes(m.id)) existing.push(m.id);
      setModelsText(existing.join("\n"));
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  };

  const canSave = baseUrlDraft.trim().length > 0 && apiKeyDraft.trim().length > 0;

  const save = () => {
    const provider: CustomProvider = {
      id: uid(),
      displayName: nameDraft.trim() || preset.name,
      baseURL: baseUrlDraft.trim(),
      apiKey: apiKeyDraft.trim(),
      format: formatDraft,
      modelIDs: modelsText.split("\n").map((l) => l.trim()).filter(Boolean),
    };
    update({ customProviders: [...customProviders, provider] });
    onClose();
    openSettings("provider", provider.id);
  };

  const goToEaon = () => {
    onClose();
    openSettings("provider", EAON_PROVIDER_ID);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add Custom Provider"
      width={640}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!canSave}>
            Save
          </Button>
        </>
      }
    >
      <p className="add-provider-sub">
        Pick the company and paste your key — Eaon fetches the models you have access to
        automatically.
      </p>
      <button type="button" className="add-provider-eaon-link" onClick={goToEaon}>
        Looking for Eaon's free hosted models instead?
      </button>

      <div className="add-provider-field">
        <div className="add-provider-label">Provider</div>
        <div className="provider-select-wrap" ref={pickerRef}>
          <button type="button" className="provider-select-trigger" onClick={() => setPickerOpen((o) => !o)}>
            <BrandLogo name={preset.name} size={20} />
            <span className="settings-grow" style={{ textAlign: "left" }}>
              {preset.name}
            </span>
            <ChevronDown size={14} />
          </button>
          {pickerOpen && (
            <div className="provider-select-list" role="listbox">
              {PRESETS.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  role="option"
                  aria-selected={p.name === preset.name}
                  className={p.name === preset.name ? "provider-select-row active" : "provider-select-row"}
                  onClick={() => choosePreset(p)}
                >
                  <BrandLogo name={p.name} size={18} />
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
        {preset.automatic && (
          <div className="add-provider-note">
            <CheckCircle2 size={13} aria-hidden />
            Connection details for {preset.name} are set up automatically.
          </div>
        )}
      </div>

      <div className="add-provider-field">
        <div className="add-provider-label">Name (optional)</div>
        <input
          className="settings-input"
          placeholder={preset.name}
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
        />
        <div className="add-provider-hint">
          What this connection is called everywhere in Eaon — the model picker, its settings row.
          Leave blank to just use "{preset.name}".
        </div>
      </div>

      <div className="add-provider-field">
        <div className="add-provider-label">API key</div>
        <input
          className="settings-input"
          type="password"
          placeholder={preset.automatic ? `Paste your ${preset.name} API key` : "Paste your API key"}
          value={apiKeyDraft}
          onChange={(e) => setApiKeyDraft(e.target.value)}
        />
        <div className="add-provider-hint">
          {preset.automatic
            ? `You get this from your ${preset.name} account (usually under "API keys"). It stays on this device only.`
            : "It stays on this device only."}
        </div>
      </div>

      <div className="add-provider-field">
        <div className="add-provider-label-row">
          <div className="add-provider-label">Models</div>
          <button type="button" className="add-provider-fetch" onClick={() => void fetchModels()} disabled={fetching}>
            <RefreshCw size={12} className={fetching ? "eaon-spin" : undefined} />
            Fetch
          </button>
        </div>
        <textarea
          className="settings-textarea add-provider-models"
          placeholder={preset.example}
          value={modelsText}
          onChange={(e) => setModelsText(e.target.value)}
          rows={4}
        />
        {fetchError && <div className="settings-error">{fetchError}</div>}
        <div className="add-provider-hint">
          Fetched automatically once your key is in — or type each model on its own line
          yourself, exactly as {preset.name} names it (for example "{preset.example}").
        </div>
      </div>

      <button
        type="button"
        className="add-provider-advanced-toggle"
        onClick={() => setAdvancedOpen((o) => !o)}
      >
        {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Advanced settings
      </button>
      {advancedOpen && (
        <div className="add-provider-advanced">
          <div className="add-provider-hint" style={{ marginBottom: 14 }}>
            Only change these if {preset.name} gave you different connection details — the
            defaults work for almost everyone.
          </div>
          <div className="add-provider-field">
            <div className="add-provider-label">Server address (base URL)</div>
            <input
              className="settings-input"
              value={baseUrlDraft}
              onChange={(e) => setBaseUrlDraft(e.target.value)}
            />
          </div>
          <div className="add-provider-field">
            <div className="add-provider-label">Request format</div>
            <select
              className="settings-select"
              value={formatDraft}
              onChange={(e) => setFormatDraft(e.target.value as ProviderFormat)}
            >
              {FORMAT_LABELS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <div className="add-provider-hint">
              The format almost every provider speaks — OpenAI, Mistral, DeepSeek, xAI,
              Perplexity, NVIDIA, and most others. If you're not sure, this is the one.
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
