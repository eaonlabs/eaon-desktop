// The Models library page (sidebar → Models): Ollama status + install
// guidance, then the installed list, curated download library, and the
// pull-by-name row (those sections live in ModelsPageSections.tsx — this
// file owns the shell and the status card).

import { useMemo } from "react";
import { Copy, ExternalLink, RefreshCw } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useModels } from "../../state/models";
import { useUi } from "../../state/ui";
import { InstalledSection, LibrarySection, PullByName } from "./ModelsPageSections";
import "./models.css";

type Platform = "windows" | "linux" | "other";

/** UA sniffing is enough here — this only picks which install command to
 *  show, and the app ships to Windows + Linux. */
function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux/i.test(ua)) return "linux";
  return "other";
}

/** A copyable one-line shell command. */
function CodeChip({ command }: { command: string }) {
  const showToast = useUi((s) => s.showToast);
  return (
    <button
      type="button"
      className="code-chip"
      title="Copy to clipboard"
      onClick={() => {
        void navigator.clipboard.writeText(command);
        showToast("Copied");
      }}
    >
      <code>{command}</code>
      <Copy size={13} />
    </button>
  );
}

function OllamaLink({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="link-button"
      onClick={() => void openUrl("https://ollama.com/download")}
    >
      <span>{label}</span>
      <ExternalLink size={12} />
    </button>
  );
}

function StatusCard() {
  const reachable = useModels((s) => s.ollamaReachable);
  const count = useModels((s) => s.ollamaModels.length);
  const platform = useMemo(detectPlatform, []);
  const refresh = () => void useModels.getState().refreshOllama();

  if (reachable) {
    return (
      <section className="status-card">
        <div className="status-row">
          <span className="status-dot is-on" />
          <div className="status-text">
            <strong>Ollama · running</strong>
            <span>{count === 1 ? "1 model installed" : `${count} models installed`}</span>
          </div>
          <button type="button" className="ghost-button" onClick={refresh}>
            <RefreshCw size={14} />
            <span>Refresh</span>
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="status-card">
      <div className="status-row">
        <span className="status-dot" />
        <div className="status-text">
          <strong>Ollama isn't running</strong>
          <span>Eaon runs local models through Ollama — install it, then refresh.</span>
        </div>
        <button type="button" className="ghost-button" onClick={refresh}>
          <RefreshCw size={14} />
          <span>Refresh</span>
        </button>
      </div>
      <div className="install-guide">
        {platform === "windows" && (
          <>
            <CodeChip command="winget install Ollama.Ollama" />
            <OllamaLink label="or download from ollama.com" />
          </>
        )}
        {platform === "linux" && (
          <CodeChip command="curl -fsSL https://ollama.com/install.sh | sh" />
        )}
        {platform === "other" && <OllamaLink label="Download from ollama.com" />}
      </div>
    </section>
  );
}

export default function ModelsPage() {
  return (
    <div className="models-page" data-selectable>
      <div className="models-scroll">
        <header className="models-header">
          <h1>Models</h1>
          <p>Download and run open models locally with Ollama.</p>
        </header>
        <StatusCard />
        <InstalledSection />
        <LibrarySection />
        <PullByName />
      </div>
    </div>
  );
}
