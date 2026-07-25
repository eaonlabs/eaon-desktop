// One BYOK connection's own dedicated settings page — mirrors
// EaonProviderPage's layout (header/key/models cards) so every provider,
// hosted or bring-your-own, manages the same way.

import { useMemo, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import Button from "../../common/Button";
import Dialog from "../../common/Dialog";
import Switch from "../../common/Switch";
import BrandLogo from "../../models/BrandLogo";
import ModelManageRow from "./ModelManageRow";
import { fetchProviderModels } from "../../../core/ipc";
import type { CustomProvider, ProviderFormat } from "../../../core/types";
import { useModels, providerDisableKey } from "../../../state/models";
import { useSettings } from "../../../state/settings";
import { useUi } from "../../../state/ui";

const FORMAT_LABELS: Array<{ value: ProviderFormat; label: string }> = [
  { value: "openai", label: "OpenAI-compatible" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Google Gemini" },
];

function ChipEditor({
  ids,
  onChange,
  placeholder,
}: {
  ids: string[];
  onChange: (ids: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const id = draft.trim();
    if (!id || ids.includes(id)) return;
    onChange([...ids, id]);
    setDraft("");
  };
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
          if (e.key === "Enter") add();
        }}
      />
    </div>
  );
}

export default function CustomProviderPage({ provider }: { provider: CustomProvider }) {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const openSettings = useUi((s) => s.openSettings);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // entries() builds a fresh array every call — calling it directly as a
  // zustand selector (rather than memoizing) breaks useSyncExternalStore's
  // "stable snapshot between unrelated renders" requirement and hangs the
  // webview in an infinite re-render loop. Recompute only when settings
  // (which covers customProviders/nicknames/favorites/hidden/disabled)
  // actually changes.
  const providerEntries = useMemo(
    () =>
      useModels
        .getState()
        .entries({ includeManaged: true })
        .filter((e) => providerDisableKey(e.provider) === provider.id),
    [settings, provider.id],
  );

  const patch = (p: Partial<CustomProvider>) =>
    update({
      customProviders: settings.customProviders.map((x) => (x.id === provider.id ? { ...x, ...p } : x)),
    });

  const enabled = !settings.disabledProviders.includes(provider.id);
  const setEnabled = (on: boolean) =>
    update({
      disabledProviders: on
        ? settings.disabledProviders.filter((k) => k !== provider.id)
        : [...settings.disabledProviders, provider.id],
    });

  const fetchModels = async () => {
    setFetching(true);
    setFetchError(null);
    try {
      const models = await fetchProviderModels(provider.baseURL, provider.apiKey || null);
      const merged = [...provider.modelIDs];
      for (const model of models) if (!merged.includes(model.id)) merged.push(model.id);
      patch({ modelIDs: merged });
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  };

  const deleteProvider = () => {
    update({ customProviders: settings.customProviders.filter((p) => p.id !== provider.id) });
    setDeleteOpen(false);
    openSettings("provider", "eaon");
  };

  return (
    <>
      <div className="pane-header">
        <div className="pane-title">{provider.displayName}</div>
      </div>

      <div className="settings-card">
        <div className="provider-head-row">
          <BrandLogo name={provider.displayName} size={28} />
          <div className="row-text">
            <input
              className="settings-input"
              style={{ fontWeight: 600, marginBottom: 4 }}
              value={provider.displayName}
              aria-label="Connection name"
              onChange={(e) => patch({ displayName: e.target.value })}
            />
            <div className="row-desc">{provider.baseURL || "No base URL set"}</div>
          </div>
          <Switch checked={enabled} onChange={setEnabled} aria-label={`Enable ${provider.displayName}`} />
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-heading">Connection</div>
        <div className="settings-row">
          <select
            className="settings-select"
            value={provider.format}
            aria-label="Wire format"
            onChange={(e) => patch({ format: e.target.value as ProviderFormat })}
          >
            {FORMAT_LABELS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-row" style={{ marginTop: 10 }}>
          <input
            className="settings-input settings-grow"
            placeholder="Base URL"
            value={provider.baseURL}
            onChange={(e) => patch({ baseURL: e.target.value })}
          />
        </div>
        <div className="settings-row" style={{ marginTop: 10 }}>
          <input
            className="settings-input settings-grow"
            type="password"
            placeholder="API key"
            value={provider.apiKey}
            onChange={(e) => patch({ apiKey: e.target.value })}
          />
        </div>
        <div className="settings-row" style={{ marginTop: 14 }}>
          <div className="settings-grow" />
          <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
            Delete connection
          </Button>
        </div>
      </div>

      <div className="settings-card">
        <div className="provider-models-head">
          <div className="settings-card-heading" style={{ marginBottom: 0 }}>
            Models
          </div>
          <button
            className="icon-btn"
            aria-label="Fetch models"
            title="Fetch models"
            onClick={() => void fetchModels()}
          >
            <RefreshCw size={14} className={fetching ? "eaon-spin" : undefined} />
          </button>
        </div>
        <div style={{ marginTop: 10 }}>
          <ChipEditor
            ids={provider.modelIDs}
            onChange={(modelIDs) => patch({ modelIDs })}
            placeholder="Add model id, press Enter"
          />
        </div>
        {fetchError && <div className="settings-error">{fetchError}</div>}
        {providerEntries.length > 0 && (
          <div className="model-list" style={{ marginTop: 16 }}>
            {providerEntries.map((entry) => (
              <ModelManageRow key={entry.key} entry={entry} />
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={`Delete ${provider.displayName}?`}
        footer={
          <>
            <Button size="sm" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={deleteProvider}>
              Delete
            </Button>
          </>
        }
      >
        <p>Its key and model list will be removed from this PC. Past chats stay.</p>
      </Dialog>
    </>
  );
}
