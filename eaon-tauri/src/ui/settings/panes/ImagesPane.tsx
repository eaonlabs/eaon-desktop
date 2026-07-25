// Image generation: the chat-tool toggle plus configured image connections
// (cloud OpenAI-compatible APIs or a local Stable Diffusion server). Ollama
// diffusion models need no setup — the pipeline finds them on its own.

import { useState } from "react";
import { X } from "lucide-react";
import Button from "../../common/Button";
import Dialog from "../../common/Dialog";
import Field from "../../common/Field";
import Switch from "../../common/Switch";
import type { ImageProvider, ImageWireFormat } from "../../../core/types";
import { uid } from "../../../core/utils";
import { useSettings } from "../../../state/settings";

const FORMAT_LABELS: Array<{ value: ImageWireFormat; label: string }> = [
  { value: "openai", label: "OpenAI-compatible" },
  { value: "automatic1111", label: "Automatic1111 (local Stable Diffusion)" },
];

const PRESETS: Array<{ name: string; baseURL: string; format: ImageWireFormat }> = [
  { name: "OpenAI", baseURL: "https://api.openai.com/v1", format: "openai" },
  { name: "Automatic1111", baseURL: "http://127.0.0.1:7860", format: "automatic1111" },
  { name: "Custom", baseURL: "", format: "openai" },
];

function IdChips({
  ids,
  onChange,
  placeholder,
}: {
  ids: string[];
  onChange: (ids: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="chip-editor">
      {ids.map((id) => (
        <span key={id} className="settings-chip">
          {id}
          <button aria-label={`Remove ${id}`} onClick={() => onChange(ids.filter((x) => x !== id))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        className="chip-input"
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          const id = draft.trim();
          if (!id || ids.includes(id)) return;
          onChange([...ids, id]);
          setDraft("");
        }}
      />
    </div>
  );
}

export default function ImagesPane() {
  const imageToolEnabled = useSettings((s) => s.settings.imageToolEnabled);
  const providers = useSettings((s) => s.settings.imageProviders);
  const update = useSettings((s) => s.update);
  const [addOpen, setAddOpen] = useState(false);

  const patch = (id: string, change: Partial<ImageProvider>) =>
    update({ imageProviders: providers.map((p) => (p.id === id ? { ...p, ...change } : p)) });

  const addPreset = (preset: (typeof PRESETS)[number]) => {
    const provider: ImageProvider = {
      id: uid(),
      displayName: preset.name === "Custom" ? "My image provider" : preset.name,
      baseURL: preset.baseURL,
      format: preset.format,
      apiKey: "",
      modelIDs: [],
    };
    update({ imageProviders: [...providers, provider] });
    setAddOpen(false);
  };

  return (
    <>
      <div className="pane-header">
        <div className="pane-title">Image generation</div>
        <div className="pane-sub">Where images come from when you ask a chat model to draw.</div>
      </div>

      <div className="settings-card">
        <Field label="Image tool" hint="Let chat models generate images.">
          <Switch
            checked={imageToolEnabled}
            onChange={(imageToolEnabled) => update({ imageToolEnabled })}
          />
        </Field>
      </div>

      {providers.map((provider) => {
        // Mirrors resolveImageBackend's usability rule so the card can say
        // WHY a connection isn't being picked up, instead of failing quietly.
        const missingBase = !provider.baseURL.trim();
        const missingModel =
          provider.format !== "automatic1111" && !(provider.modelIDs[0] ?? "").trim();
        return (
        <div key={provider.id} className="settings-card">
          <div className="settings-row">
            <input
              className="settings-input settings-grow"
              style={{ fontWeight: 600 }}
              value={provider.displayName}
              aria-label="Image provider name"
              onChange={(e) => patch(provider.id, { displayName: e.target.value })}
            />
            <select
              className="settings-select"
              style={{ width: "auto" }}
              value={provider.format}
              aria-label="Wire format"
              onChange={(e) => patch(provider.id, { format: e.target.value as ImageWireFormat })}
            >
              {FORMAT_LABELS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <div className="settings-row">
            <input
              className="settings-input settings-grow"
              placeholder="Base URL"
              value={provider.baseURL}
              onChange={(e) => patch(provider.id, { baseURL: e.target.value })}
            />
          </div>
          {provider.format !== "automatic1111" && (
            <div className="settings-row">
              <input
                className="settings-input settings-grow"
                type="password"
                placeholder="API key"
                value={provider.apiKey}
                onChange={(e) => patch(provider.id, { apiKey: e.target.value })}
              />
            </div>
          )}
          <div className="settings-row" style={{ alignItems: "flex-start" }}>
            <div className="settings-grow">
              <IdChips
                ids={provider.modelIDs}
                onChange={(modelIDs) => patch(provider.id, { modelIDs })}
                placeholder={
                  provider.format === "automatic1111"
                    ? "Display label (whatever's loaded runs)"
                    : "Add model id, press Enter"
                }
              />
            </div>
          </div>
          {(missingBase || missingModel) && (
            <div className="settings-error" style={{ color: "var(--warning)" }}>
              {missingBase
                ? "Add a base URL — this connection is skipped until it has one."
                : "Add a model id — this connection is skipped until it has one."}
            </div>
          )}
          <div className="settings-row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
            <Button
              variant="danger"
              size="sm"
              onClick={() =>
                update({ imageProviders: providers.filter((p) => p.id !== provider.id) })
              }
            >
              Delete
            </Button>
          </div>
        </div>
        );
      })}

      <div style={{ marginTop: 12 }}>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          Add image provider
        </Button>
      </div>

      <div className="settings-note">
        The first complete connection above is used; with none, Eaon's hosted image models and
        Ollama diffusion models are picked up automatically.
      </div>

      <Dialog open={addOpen} onClose={() => setAddOpen(false)} title="Add image provider">
        <div className="preset-grid">
          {PRESETS.map((preset) => (
            <button key={preset.name} className="preset-cell" onClick={() => addPreset(preset)}>
              {preset.name}
            </button>
          ))}
        </div>
      </Dialog>
    </>
  );
}
