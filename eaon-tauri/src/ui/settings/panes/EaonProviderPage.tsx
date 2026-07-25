// The "Eaon API" provider page — the hosted connection's own dedicated
// settings page (enable toggle, key, and full model management), reached
// via its row in the sidebar's MODEL PROVIDERS section rather than a
// shared all-providers list.

import { useMemo, useState } from "react";
import { Droplet, Lock, RefreshCw } from "lucide-react";
import Button from "../../common/Button";
import Switch from "../../common/Switch";
import ModelManageRow from "./ModelManageRow";
import { EAON_PROVIDER_ID } from "../../../state/ui";
import { useModels, providerDisableKey } from "../../../state/models";
import { useSettings } from "../../../state/settings";
import { useUi } from "../../../state/ui";

export default function EaonProviderPage() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const hostedModels = useModels((s) => s.hostedModels);
  const hostedError = useModels((s) => s.hostedError);
  const showToast = useUi((s) => s.showToast);
  const [keyDraft, setKeyDraft] = useState(settings.eaonApiKey);
  const [refreshing, setRefreshing] = useState(false);

  // entries() builds a fresh array every call — calling it directly as a
  // zustand selector (rather than memoizing) breaks useSyncExternalStore's
  // "stable snapshot between unrelated renders" requirement and hangs the
  // webview in an infinite re-render loop. Recompute only when the reactive
  // pieces it actually depends on change.
  const eaonEntries = useMemo(
    () =>
      useModels
        .getState()
        .entries({ includeManaged: true })
        .filter((e) => providerDisableKey(e.provider) === EAON_PROVIDER_ID),
    [hostedModels, settings],
  );

  const enabled = !settings.disabledProviders.includes(EAON_PROVIDER_ID);
  const setEnabled = (on: boolean) =>
    update({
      disabledProviders: on
        ? settings.disabledProviders.filter((k) => k !== EAON_PROVIDER_ID)
        : [...settings.disabledProviders, EAON_PROVIDER_ID],
    });

  const saveKey = () => {
    update({ eaonApiKey: keyDraft.trim() });
    void useModels.getState().refreshHosted();
    showToast("Eaon API key saved");
  };

  const refresh = async () => {
    setRefreshing(true);
    await useModels.getState().refreshHosted();
    setRefreshing(false);
  };

  return (
    <>
      <div className="pane-header">
        <div className="pane-title">Eaon API</div>
      </div>

      <div className="settings-card">
        <div className="provider-head-row">
          <span className="provider-icon-tile">
            <Droplet size={18} fill="currentColor" />
          </span>
          <div className="row-text">
            <div className="row-title">Eaon API</div>
            <div className="row-desc">Hosted models via your Eaon API key</div>
          </div>
          <Switch checked={enabled} onChange={setEnabled} aria-label="Enable Eaon API" />
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-heading">API Key</div>
        <div className="row-desc" style={{ marginBottom: 14 }}>
          Your key stays on this device — saved locally in the app's own settings, sent only as
          an authorization header when you send a message.
        </div>
        <div className="settings-row">
          <input
            className="settings-input settings-grow"
            type="password"
            placeholder="eaon-…"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
          />
          <Button variant="primary" onClick={saveKey} disabled={!keyDraft.trim()}>
            Save
          </Button>
        </div>
        {settings.eaonApiKey && (
          <div className="settings-note" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Lock size={12} aria-hidden />
            API key saved on this device
          </div>
        )}
        {hostedError && !settings.eaonApiKey && (
          <div className="settings-note">{hostedError}</div>
        )}
      </div>

      <div className="settings-card">
        <div className="provider-models-head">
          <div className="settings-card-heading" style={{ marginBottom: 0 }}>
            Models
          </div>
          <button
            className="icon-btn"
            aria-label="Refresh models"
            title="Refresh models"
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} className={refreshing ? "eaon-spin" : undefined} />
          </button>
        </div>
        {eaonEntries.length === 0 ? (
          <div className="settings-note" style={{ marginTop: 10 }}>
            {settings.eaonApiKey
              ? "No hosted models reachable right now."
              : "Add your key above to see hosted models here — or use the separate Free Trial provider, no key needed."}
          </div>
        ) : (
          <div className="model-list">
            {eaonEntries.map((entry) => (
              <ModelManageRow key={entry.key} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
