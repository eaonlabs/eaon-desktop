// Local models: the Ollama connection. Install commands are copyable chips
// per platform; the Models library (pull/delete) lives in the sidebar — this
// pane only wires the connection and points there.

import { Copy } from "lucide-react";
import Button from "../../common/Button";
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
        <div className="pane-sub">Models that run entirely on this PC, served by Ollama.</div>
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

      <div className="settings-note">
        Running llama.cpp or LM Studio? Add its server as an OpenAI-compatible provider.
      </div>
    </>
  );
}
