// The "Free Trial" provider page — its own dedicated connection, entirely
// independent of the Eaon API page: no key of its own, always available
// regardless of whether the user has one, with the same hosted catalog
// mirrored under this provider's own picker keys (see state/models.ts).

import { useMemo, useState } from "react";
import { Gift, Lock, RefreshCw } from "lucide-react";
import Switch from "../../common/Switch";
import ModelManageRow from "./ModelManageRow";
import TrialCard from "./TrialCard";
import { activeTrial } from "../../../chat/modelRouting";
import { FREE_TRIAL_PROVIDER_ID } from "../../../state/ui";
import { useModels, providerDisableKey } from "../../../state/models";
import { useSettings } from "../../../state/settings";

export default function FreeTrialProviderPage() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const hostedModels = useModels((s) => s.hostedModels);
  const hostedError = useModels((s) => s.hostedError);
  const [refreshing, setRefreshing] = useState(false);

  // Same memoization rule as every other provider page: entries() allocates
  // a fresh array per call, so it can't be a direct zustand selector without
  // hanging the webview in a render loop — recompute only on real changes.
  const trialEntries = useMemo(
    () =>
      useModels
        .getState()
        .entries({ includeManaged: true })
        .filter((e) => providerDisableKey(e.provider) === FREE_TRIAL_PROVIDER_ID),
    [hostedModels, settings],
  );

  // Locked while a trial is actively counting down — the point isn't that
  // toggling would pause the clock (it never does; expiresAt is fixed at
  // mint time and nothing here ever touches it), it's that the control
  // itself shouldn't be fiddled with mid-trial at all.
  const isActive = activeTrial(settings.trialCredential) !== null;
  const enabled = !settings.disabledProviders.includes(FREE_TRIAL_PROVIDER_ID);
  const setEnabled = (on: boolean) => {
    if (isActive) return;
    update({
      disabledProviders: on
        ? settings.disabledProviders.filter((k) => k !== FREE_TRIAL_PROVIDER_ID)
        : [...settings.disabledProviders, FREE_TRIAL_PROVIDER_ID],
    });
  };

  const refresh = async () => {
    setRefreshing(true);
    await useModels.getState().refreshHosted();
    setRefreshing(false);
  };

  return (
    <>
      <div className="pane-header">
        <div className="pane-title">Free Trial</div>
      </div>

      <div className="settings-card">
        <div className="provider-head-row">
          <span className="provider-icon-tile">
            <Gift size={17} />
          </span>
          <div className="row-text">
            <div className="row-title">Free Trial</div>
            <div className="row-desc">
              7 days of every hosted model, no key needed — independent of your Eaon API key,
              on or off.
            </div>
          </div>
          <Switch
            checked={enabled}
            onChange={setEnabled}
            disabled={isActive}
            aria-label="Enable Free Trial"
          />
        </div>
        {isActive && (
          <div className="settings-note" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Lock size={12} aria-hidden />
            Locked while your Free Week is active — it'll unlock once the week is over.
          </div>
        )}
      </div>

      <TrialCard />

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
        {trialEntries.length === 0 ? (
          <div className="settings-note" style={{ marginTop: 10 }}>
            {enabled
              ? hostedError ?? "No hosted models reachable right now."
              : "Turn Free Trial back on above to see hosted models here."}
          </div>
        ) : (
          <div className="model-list">
            {trialEntries.map((entry) => (
              <ModelManageRow key={entry.key} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
