// Local models: the Ollama connection. Install commands are copyable chips
// per platform; the Models library (pull/delete) lives in the sidebar — this
// pane only wires the connection and points there.

import { useCallback, useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import Button from "../../common/Button";
import { llamaStart, llamaStatus, llamaStop, type LlamaStatus } from "../../../core/ipc";
import { DEFAULT_OLLAMA_URL } from "../../../core/catalog";
import { useModels } from "../../../state/models";
import { useSettings } from "../../../state/settings";
import { useUi } from "../../../state/ui";

const INSTALLS: Array<{ platform: string; command: string }> = [
  { platform: "Windows", command: "winget install Ollama.Ollama" },
  { platform: "Linux", command: "curl -fsSL https://ollama.com/install.sh | sh" },
];

export default function LocalPane() {
  const ollamaBaseUrl = useSettings((s) => s.settings.ollamaBaseUrl);
  const update = useSettings((s) => s.update);
  const reachable = useModels((s) => s.ollamaReachable);
  const installedCount = useModels((s) => s.ollamaModels.length);
  const refreshOllama = useModels((s) => s.refreshOllama);
  const setSelection = useUi((s) => s.setSelection);
  const showToast = useUi((s) => s.showToast);

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    showToast("Copied");
  };

  return (
    <>
      <div className="pane-header">
        <div className="pane-title">Local models</div>
        <div className="pane-sub">Models that run entirely on this PC, served by Ollama or llama.cpp.</div>
      </div>

      <div className="settings-card">
        <div className="settings-row">
          <span className={reachable ? "status-dot on" : "status-dot"} />
          <div className="settings-card-title settings-grow">
            {reachable
              ? `Ollama connected — ${installedCount} ${installedCount === 1 ? "model" : "models"} installed`
              : "Ollama isn't reachable"}
          </div>
          <Button size="sm" onClick={() => void refreshOllama()}>
            Refresh
          </Button>
        </div>
        <div className="settings-row" style={{ marginTop: 10 }}>
          <input
            className="settings-input settings-grow"
            placeholder={DEFAULT_OLLAMA_URL}
            value={ollamaBaseUrl}
            aria-label="Ollama base URL"
            onChange={(e) => update({ ollamaBaseUrl: e.target.value })}
          />
          {ollamaBaseUrl !== DEFAULT_OLLAMA_URL && (
            <Button variant="ghost" size="sm" onClick={() => update({ ollamaBaseUrl: DEFAULT_OLLAMA_URL })}>
              Reset to default
            </Button>
          )}
        </div>
        <div className="settings-row" style={{ marginTop: 10 }}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setSelection({ kind: "models" })}
          >
            Open Models library
          </Button>
        </div>
      </div>

      {!reachable && (
        <div className="settings-card">
          <div className="settings-card-title">Don't have Ollama yet?</div>
          <div className="settings-card-sub" style={{ marginBottom: 10 }}>
            One command installs it — then hit Refresh above.
          </div>
          {INSTALLS.map(({ platform, command }) => (
            <div key={platform} className="key-row">
              <span className="tag-chip">{platform}</span>
              <code>{command}</code>
              <button className="icon-btn" aria-label={`Copy ${platform} install command`} onClick={() => copy(command)}>
                <Copy size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <LlamaCppCard />

      <div className="settings-note">
        Running LM Studio or another local server? Add it as an OpenAI-compatible provider.
      </div>
    </>
  );
}

/** llama.cpp: run a GGUF file straight off disk. Once llama-server is up it
 *  speaks the OpenAI wire format, so the rest of the app talks to it with no
 *  special casing — this card only finds the binary, starts it, and reports.
 *
 *  There is no MLX card beside this one on purpose: MLX is Apple-silicon
 *  only, so the Mac app's third local backend cannot exist on Windows or
 *  Linux at all. */
function LlamaCppCard() {
  const [status, setStatus] = useState<LlamaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const showToast = useUi((s) => s.showToast);

  const refresh = useCallback(async () => {
    try {
      setStatus(await llamaStatus());
    } catch {
      // A status probe that can't run tells us nothing worth interrupting for.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pickAndStart = async () => {
    const picked = await openFileDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "GGUF model", extensions: ["gguf"] }],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      setStatus(await llamaStart({ modelPath: picked }));
      showToast("llama.cpp is serving that model");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await llamaStop();
      showToast("llama.cpp stopped");
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const fileName = status?.modelPath?.split(/[/\\]/).pop() ?? null;

  return (
    <div className="settings-card">
      <div className="settings-card-heading">llama.cpp</div>
      <div className="settings-row">
        <span className={status?.running ? "status-dot on" : "status-dot"} />
        <div className="settings-card-title settings-grow">
          {status?.running && fileName
            ? `Serving ${fileName}`
            : status?.installed
              ? "llama-server found, not running"
              : "llama-server isn't installed"}
        </div>
        {status?.running ? (
          <Button size="sm" onClick={() => void stop()} disabled={busy}>
            Stop
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            onClick={() => void pickAndStart()}
            disabled={busy || !status?.installed}
          >
            {busy ? "Starting…" : "Open a GGUF model"}
          </Button>
        )}
      </div>

      <div className="settings-card-sub" style={{ marginTop: 8 }}>
        {status?.running
          ? `Serving an OpenAI-compatible API at ${status.baseUrl}. Add that as a provider to chat with it.`
          : status?.installed
            ? "Pick a .gguf file and Eaon will run it on this PC. Nothing leaves the machine."
            : "Install llama.cpp so that llama-server is on your PATH, then reopen this page."}
      </div>

      {status?.installed && status.binaryPath && !status.running && (
        <div className="key-row" style={{ marginTop: 10 }}>
          <span className="tag-chip">Binary</span>
          <code>{status.binaryPath}</code>
        </div>
      )}
    </div>
  );
}
