// Eaon CLI: install the standalone `eaon` command, keep it updated, and
// link this app's saved API keys into its config so a fresh install is
// usable immediately — no copy-pasting keys into a second place. The
// cross-platform port of the Mac app's EaonCLIInfoSheet, as its own
// Settings page rather than a sheet (matches how every other Tools entry
// here is reached), minus the embedded-terminal-specific bits that don't
// apply outside that app.

import { useEffect, useState } from "react";
import { CheckCircle2, Copy, Download, FolderOpen, RefreshCw, XCircle } from "lucide-react";
import Button from "../../common/Button";
import { eaonCliInstall, eaonCliLinkCredentials, eaonCliStatus, runAgentTool, type CliStatus } from "../../../core/ipc";
import type { CustomProvider, Settings } from "../../../core/types";
import { useSettings } from "../../../state/settings";
import { useUi } from "../../../state/ui";

const MODES = [
  ["Chat", "Plain conversation, no tools."],
  ["Agent", "A coding agent scoped to your project — write, edit, read, run shell, and more."],
  ["Claw", "Agent's tools plus the wider system: trash, open/quit apps, open URLs."],
];

const KEY_COMMANDS = [
  ["/mode <chat|agent|claw>", "Switch mode"],
  ["/model [name]", "Switch model, or list all"],
  ["/pull <name>", "Download a model via Ollama"],
  ["/permission [sandboxed|auto]", "Show or set the permission mode"],
  ["/link", "Import API keys from this app"],
  ["/init", "Scan the project and write EAON.md"],
  ["/resume [id]", "List or reopen a past session"],
  ["/help", "List every command"],
];

const PERMISSION_MODES = [
  ["Sandboxed", "Every non-read action asks first (default)."],
  ["Auto", "Actions run immediately — toggle with Shift+Tab."],
];

/** What actually gets copied into the CLI's config.json — the Eaon key plus
 *  every BYOK connection, exactly as they're saved in this app right now. */
function buildLinkArgs(settings: Settings) {
  return {
    eaonApiKey: settings.eaonApiKey || null,
    customProviders: settings.customProviders.map((p: CustomProvider) => ({
      id: p.id,
      displayName: p.displayName,
      baseUrl: p.baseURL,
      apiKey: p.apiKey,
      modelIds: p.modelIDs,
      format: p.format,
    })),
  };
}

export default function EaonCliPane() {
  const settings = useSettings((s) => s.settings);
  const showToast = useUi((s) => s.showToast);
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refresh = async () => {
    const next = await eaonCliStatus();
    setStatus(next);
    return next;
  };

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const install = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      await eaonCliInstall();
      // The whole point of "Install Now" per the user's own ask: land ready
      // to use, not ready-to-be-configured — link whatever's already saved
      // in this app the moment the program files exist.
      await eaonCliLinkCredentials(buildLinkArgs(useSettings.getState().settings));
      await refresh();
      showToast("Eaon CLI installed and linked to your API keys");
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  };

  const syncCredentials = async () => {
    setSyncing(true);
    try {
      await eaonCliLinkCredentials(buildLinkArgs(settings));
      showToast("API keys synced to Eaon CLI");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Couldn't sync API keys");
    } finally {
      setSyncing(false);
    }
  };

  const openPath = async (path: string, label: string) => {
    const outcome = await runAgentTool("open_path", { path });
    if (!outcome.ok) showToast(`Couldn't open ${label}`);
  };

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    showToast("Copied");
  };

  return (
    <>
      <div className="pane-header">
        <div className="pane-title">Eaon CLI</div>
        <div className="pane-sub">
          Eaon in your terminal — agentic coding and chat, for any model you have: hosted, BYOK, or a local Ollama model.
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-heading">Status</div>
        <StatusLine
          ok={!!status?.nodePath}
          label="Node.js"
          detail={loading ? "Checking…" : status?.nodePath ?? status?.nodeHint ?? ""}
        />
        <StatusLine
          ok={!!status?.entryPoint}
          label="CLI build"
          detail={
            loading
              ? "Checking…"
              : status?.entryPoint ?? (status?.canInstall ? "Not installed yet — click Install below" : "Not available in this build yet")
          }
        />
        {status?.isReady && (
          <div className="settings-note" style={{ marginTop: 10 }}>
            Run <code>eaon</code> in any terminal once installed below.
          </div>
        )}
      </div>

      {status?.canInstall && (
        <div className="settings-card">
          <div className="settings-card-heading">Install Eaon CLI</div>
          <div className="row-desc">
            A ready-to-run copy ships inside this app. Installing copies it to {status.installedDirectory} — no download, no npm,
            works offline — and automatically copies your Eaon API key and any BYOK providers you've saved here into the CLI's own
            config, so it's ready to use immediately.
          </div>
          {installError && <div className="settings-error">{installError}</div>}
          <div style={{ marginTop: 12 }}>
            <Button variant="primary" size="sm" loading={installing} onClick={() => void install()}>
              <Download size={13} aria-hidden />
              {installing ? "Installing…" : "Install Now"}
            </Button>
          </div>
          <div className="settings-note">
            If <code>eaon</code> doesn't run in a new terminal afterward, add {status.globalCommandPath.replace(/[\\/][^\\/]+$/, "")} to
            your PATH — it isn't there by default on any of the three platforms this app ships to.
          </div>
        </div>
      )}

      {status?.updateAvailable && (
        <div className="settings-card">
          <div className="settings-card-heading">Update available</div>
          <div className="row-desc">
            This app now bundles Eaon CLI v{status.updateAvailable} — you have v{status.installedVersion} installed. Updating
            replaces the program files at {status.installedDirectory}; your config and sessions in {status.configDirectory} are
            untouched.
          </div>
          <div style={{ marginTop: 12 }}>
            <Button variant="primary" size="sm" loading={installing} onClick={() => void install()}>
              <RefreshCw size={13} aria-hidden />
              {installing ? "Updating…" : "Update Now"}
            </Button>
          </div>
        </div>
      )}

      {!!status?.installedVersion && (
        <div className="settings-card">
          <div className="settings-card-heading">API keys</div>
          <div className="settings-detail-row">
            <div className="row-text">
              <div className="row-title">Sync API keys</div>
              <div className="row-desc">
                Copies your current Eaon API key and BYOK providers into the CLI's config — already done automatically when you
                installed; use this again after rotating a key.
              </div>
            </div>
            <Button size="sm" loading={syncing} onClick={() => void syncCredentials()}>
              Sync now
            </Button>
          </div>
        </div>
      )}

      {status?.cliDirectory && (
        <div className="settings-card">
          <div className="settings-card-heading">Run it in any terminal</div>
          <div className="row-desc">Build it once and link a global `eaon` command, then run it from any project folder.</div>
          <CommandRow command={`cd "${status.cliDirectory}"`} onCopy={copy} />
          <CommandRow command="npm install" onCopy={copy} />
          <CommandRow command="npm run build" onCopy={copy} />
          <CommandRow command="npm link" onCopy={copy} />
        </div>
      )}

      <div className="settings-card">
        <div className="settings-card-heading">Configuration</div>
        <div className="row-desc">
          The CLI keeps its own settings file — your Eaon/BYOK keys, Ollama URL, custom providers, default mode, permission mode,
          and custom instructions.
        </div>
        {status && (
          <div className="key-row" style={{ marginTop: 10 }}>
            <code>{status.configFile}</code>
            <button onClick={() => void copy(status.configFile)} aria-label="Copy path" className="icon-btn">
              <Copy size={13} />
            </button>
          </div>
        )}
        <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
          <Button size="sm" onClick={() => status && void openPath(status.configFile, "the config file")}>
            <FolderOpen size={13} aria-hidden />
            Open
          </Button>
          <Button size="sm" onClick={() => status && void openPath(status.configDirectory, "the config folder")}>
            Reveal
          </Button>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-heading">Reference</div>
        <ReferenceGroup title="Modes" rows={MODES} />
        <ReferenceGroup title="Key commands" rows={KEY_COMMANDS} />
        <ReferenceGroup title="Permission modes" rows={PERMISSION_MODES} />
      </div>
    </>
  );
}

function StatusLine({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 8 }}>
      {ok ? (
        <CheckCircle2 size={14} style={{ color: "var(--diff-add)", flexShrink: 0, marginTop: 1 }} />
      ) : (
        <XCircle size={14} style={{ color: "var(--text-muted)", flexShrink: 0, marginTop: 1 }} />
      )}
      <div style={{ minWidth: 0 }}>
        <div className="row-title" style={{ fontSize: 13.5 }}>
          {label}
        </div>
        <div className="row-desc" style={{ marginTop: 1, overflowWrap: "anywhere" }}>
          {detail}
        </div>
      </div>
    </div>
  );
}

function CommandRow({ command, onCopy }: { command: string; onCopy: (text: string) => void }) {
  return (
    <div className="key-row" style={{ marginTop: 8 }}>
      <code>{command}</code>
      <button onClick={() => onCopy(command)} aria-label="Copy command" className="icon-btn">
        <Copy size={13} />
      </button>
    </div>
  );
}

function ReferenceGroup({ title, rows }: { title: string; rows: string[][] }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div className="settings-section-label" style={{ margin: "0 0 6px" }}>
        {title}
      </div>
      <table className="settings-table">
        <tbody>
          {rows.map(([left, right]) => (
            <tr key={left}>
              <td style={{ whiteSpace: "nowrap" }}>
                <code>{left}</code>
              </td>
              <td>{right}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
