// General: version + update check, the data folder, the Free Week gift, and
// About/Support. One card from the Mac app's own General page — Desktop
// Assistant (a floating always-on-top panel + global hotkey + tray icon) —
// isn't here: it doesn't exist yet in this Windows/Linux build, and a
// toggle for a feature that isn't wired to anything would be worse than no
// row at all. The Eaon CLI manager, unlike Desktop Assistant, IS ported —
// as its own Settings → Tools → Eaon CLI page rather than a General-page
// card, matching how every other Tools entry (Plugins, Local API Server…)
// is reached in this app.

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Copy, ExternalLink, Folder, Mail } from "lucide-react";
import Button from "../../common/Button";
import Switch from "../../common/Switch";
import TrialCard from "./TrialCard";
import { appDataDirPath, runAgentTool } from "../../../core/ipc";
import { checkForUpdate, installUpdateNow, type InstallProgress } from "../../../core/update";
import { useSettings } from "../../../state/settings";
import { useUi } from "../../../state/ui";

export default function GeneralPane() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const uiUpdate = useUi((s) => s.update);
  const showToast = useUi((s) => s.showToast);
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const [dataDir, setDataDir] = useState("");
  const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null);

  useEffect(() => {
    void getVersion().then(setVersion);
    void appDataDirPath().then(setDataDir);
  }, []);

  const check = async () => {
    setChecking(true);
    await checkForUpdate();
    setChecking(false);
    if (!useUi.getState().update) showToast("You're up to date");
  };

  const installing = installProgress !== null && installProgress.phase !== "failed";

  const install = async () => {
    setInstallProgress({ phase: "downloading", fraction: null });
    await installUpdateNow(setInstallProgress);
  };

  const installLabel = (() => {
    if (!installProgress) return "Update Now";
    switch (installProgress.phase) {
      case "downloading":
        return installProgress.fraction != null
          ? `Downloading… ${Math.round(installProgress.fraction * 100)}%`
          : "Downloading…";
      case "installing":
        return "Installing…";
      case "relaunching":
        return "Restarting…";
      case "failed":
        return "Retry Update";
    }
  })();

  const openDataFolder = async () => {
    if (!dataDir) return;
    const outcome = await runAgentTool("open_path", { path: dataDir });
    if (!outcome.ok) showToast("Couldn't open the folder");
  };

  const copyDataDir = async () => {
    await navigator.clipboard.writeText(dataDir);
    showToast("Copied");
  };

  return (
    <>
      <div className="pane-header">
        <div className="pane-title">General</div>
        <div className="pane-sub">Version, updates, and the fine print.</div>
      </div>

      <div className="settings-card">
        <div className="settings-card-heading">General</div>
        <div className="settings-detail-row">
          <div className="row-text">
            <div className="row-title">App Version</div>
          </div>
          <div className="row-value">{version || "…"}</div>
        </div>
        <div className="settings-detail-row">
          <div className="row-text">
            <div className="row-title">Automatic Update Check</div>
            <div className="row-desc">Automatically check for updates on startup and periodically.</div>
          </div>
          <Switch
            checked={settings.autoUpdateEnabled}
            onChange={(autoUpdateEnabled) => update({ autoUpdateEnabled })}
          />
        </div>
        <div className="settings-detail-row">
          <div className="row-text">
            <div className="row-title">Check for Updates</div>
            <div className="row-desc">Check if a newer version of Eaon is available.</div>
          </div>
          <Button size="sm" loading={checking} onClick={() => void check()}>
            Check for Updates
          </Button>
        </div>
      </div>

      {uiUpdate && (
        <div className="settings-card">
          <div className="settings-detail-row">
            <div className="row-text">
              <div className="row-title">Eaon {uiUpdate.latestVersion} is available</div>
              {uiUpdate.releaseNotes && <div className="row-desc">{uiUpdate.releaseNotes}</div>}
              {installProgress?.phase === "failed" && (
                <div className="settings-error">{installProgress.message}</div>
              )}
            </div>
            <Button variant="primary" size="sm" loading={installing} onClick={() => void install()}>
              {installLabel}
            </Button>
          </div>
        </div>
      )}

      <div className="settings-card">
        <div className="settings-card-heading">Data Folder</div>
        <div className="settings-detail-row">
          <div className="row-text">
            <div className="row-title">App Data</div>
            <div className="row-desc">Downloaded local models and file attachments.</div>
          </div>
          <Button size="sm" onClick={() => void openDataFolder()}>
            <Folder size={13} aria-hidden />
            Open folder
          </Button>
        </div>
        {dataDir && (
          <div className="key-row" style={{ marginTop: 4 }}>
            <code>{dataDir}</code>
            <button onClick={() => void copyDataDir()} aria-label="Copy path" className="icon-btn">
              <Copy size={13} />
            </button>
          </div>
        )}
      </div>

      <TrialCard />

      <div className="settings-card">
        <div className="settings-card-heading">About</div>
        <div className="settings-detail-row">
          <div className="row-text">
            <div className="row-title">Website</div>
            <div className="row-desc">Unified free AI API platform for top models.</div>
          </div>
          <Button size="sm" onClick={() => void openUrl("https://eaon.dev")}>
            <ExternalLink size={13} aria-hidden />
            eaon.dev
          </Button>
        </div>
        <div className="settings-detail-row">
          <div className="row-text">
            <div className="row-title">Support</div>
            <div className="row-desc">support@eaon.dev</div>
          </div>
          <Button size="sm" onClick={() => void openUrl("mailto:support@eaon.dev")}>
            <Mail size={13} aria-hidden />
            Email Us
          </Button>
        </div>
      </div>

      <div className="settings-note">Eaon is free software, released under the GPLv3 license.</div>
    </>
  );
}
