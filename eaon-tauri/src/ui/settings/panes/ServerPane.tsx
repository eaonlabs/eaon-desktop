// Local API server: a real loopback OpenAI-compatible endpoint serving every
// model this app can reach. Enabling actually starts the listener (Rust owns
// the socket); a failed start reverts the toggle rather than lying.

import { useEffect, useState } from "react";
import { Copy, RefreshCw } from "lucide-react";
import Field from "../../common/Field";
import Switch from "../../common/Switch";
import { generateLocalServerKey } from "../../../core/catalog";
import { localServerRunning, stopLocalServer } from "../../../core/ipc";
import { startLocalServerFromSettings } from "../../../state/localServer";
import { useSettings } from "../../../state/settings";
import { useUi } from "../../../state/ui";

export default function ServerPane() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const showToast = useUi((s) => s.showToast);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [portDraft, setPortDraft] = useState(String(settings.localServerPort));

  useEffect(() => {
    void localServerRunning().then(setRunning);
  }, []);

  const start = async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await startLocalServerFromSettings();
      setRunning(true);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    try {
      await stopLocalServer();
    } catch {
      // Already stopped is fine — the goal state is "not listening".
    }
    setRunning(false);
  };

  const setEnabled = async (on: boolean) => {
    if (on) {
      const ok = await start();
      update({ localServerEnabled: ok }); // failure reverts the toggle
    } else {
      await stop();
      update({ localServerEnabled: false });
    }
  };

  const restartIfRunning = async () => {
    if (!running) return;
    await stop();
    await start();
  };

  const commitPort = () => {
    const port = Math.min(65535, Math.max(1, Math.round(Number(portDraft)) || 1234));
    setPortDraft(String(port));
    if (port !== settings.localServerPort) {
      update({ localServerPort: port });
      void restartIfRunning();
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    showToast("Copied");
  };

  const endpoint = `http://127.0.0.1:${settings.localServerPort}/v1`;

  return (
    <>
      <div className="pane-header">
        <div className="pane-title">Local API server</div>
        <div className="pane-sub">OpenAI-compatible — point any tool at it.</div>
      </div>

      <div className="settings-card">
        <Field
          label="Serve models on this PC"
          hint="Opens a listening port on 127.0.0.1 while enabled — it comes back on its own each time the app starts."
        >
          <div className="settings-row">
            <span className={running ? "status-dot on" : "status-dot"} />
            <Switch
              checked={settings.localServerEnabled}
              disabled={busy}
              onChange={(on) => void setEnabled(on)}
            />
          </div>
        </Field>
        {error && <div className="settings-error">{error}</div>}
      </div>

      <div className="settings-card">
        <Field label="Port">
          <input
            className="settings-input-sm"
            type="number"
            min={1}
            max={65535}
            value={portDraft}
            onChange={(e) => setPortDraft(e.target.value)}
            onBlur={commitPort}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitPort();
            }}
          />
        </Field>
        <Field label="Require API key" hint="Callers must send the bearer key below.">
          <Switch
            checked={settings.localServerRequireApiKey}
            onChange={(localServerRequireApiKey) => {
              update({ localServerRequireApiKey });
              void restartIfRunning();
            }}
          />
        </Field>

        <div className="key-row" style={{ marginTop: 12 }}>
          <code>{settings.localServerApiKey || "A key is generated when the server first starts"}</code>
          {settings.localServerApiKey && (
            <button className="icon-btn" aria-label="Copy API key" onClick={() => copy(settings.localServerApiKey)}>
              <Copy size={13} />
            </button>
          )}
          <button
            className="icon-btn"
            aria-label="Regenerate API key"
            onClick={() => {
              update({ localServerApiKey: generateLocalServerKey() });
              void restartIfRunning();
              showToast("New key generated");
            }}
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="key-row">
          <code>{endpoint}</code>
          <button className="icon-btn" aria-label="Copy endpoint" onClick={() => copy(endpoint)}>
            <Copy size={13} />
          </button>
        </div>
      </div>
    </>
  );
}
