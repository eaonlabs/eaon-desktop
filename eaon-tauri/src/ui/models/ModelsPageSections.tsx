// Models page sections: the installed ("On this PC") list, the curated
// download library, and the pull-by-name row. Pull orchestration is a
// module-level function so library cards and the manual row share one
// channel-plumbing path into the models store.

import { useEffect, useMemo, useState } from "react";
import { Check, Download, Trash2 } from "lucide-react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { ollamaDelete, ollamaPull, systemSpecs } from "../../core/ipc";
import { formatBytes } from "../../core/utils";
import type { FitVerdict, PullState, SystemSpecs } from "../../core/types";
import { CURATED_CATEGORIES, estimateFit } from "../../core/curated";
import type { CuratedModel } from "../../core/curated";
import { useModels } from "../../state/models";
import { useSettings } from "../../state/settings";
import { useUi } from "../../state/ui";
import BrandLogo from "./BrandLogo";

/** Starts an Ollama pull and mirrors its progress into the models store.
 *  The pull API has no cancel — callers hide their button while one runs.
 *  On success the installed list (and thus the picker) refreshes. */
function startPull(model: string): void {
  const tag = model.trim();
  if (!tag) return;
  const { pulls, setPull, refreshOllama } = useModels.getState();
  const existing = pulls[tag];
  if (existing && !existing.error) return; // already downloading
  const baseUrl = useSettings.getState().settings.ollamaBaseUrl;
  setPull(tag, { status: "Starting download…", completed: 0, total: 0 });
  ollamaPull(baseUrl, tag, (event) => {
    if (event.type === "progress") {
      setPull(tag, { status: event.status, completed: event.completed, total: event.total });
    } else if (event.type === "done") {
      setPull(tag, null);
      void refreshOllama();
    } else {
      setPull(tag, { status: "Failed", completed: 0, total: 0, error: event.message });
    }
  }).catch((error) => {
    setPull(tag, { status: "Failed", completed: 0, total: 0, error: String(error) });
  });
}

function PullProgress({ pull }: { pull: PullState }) {
  const pct = pull.total > 0 ? Math.min(100, (pull.completed / pull.total) * 100) : 0;
  return (
    <div className="pull-progress">
      <div className="pull-progress-meta">
        <span>{pull.status}</span>
        {pull.total > 0 && (
          <span>
            {formatBytes(pull.completed)} / {formatBytes(pull.total)} · {Math.round(pct)}%
          </span>
        )}
      </div>
      <div className="pull-track">
        <div className="pull-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const FIT_LABELS: Record<Exclude<FitVerdict, "unknown">, string> = {
  fits: "Fits well",
  tight: "Might be tight",
  "too-big": "Too big",
};

function FitBadge({ verdict }: { verdict: FitVerdict }) {
  if (verdict === "unknown") return null;
  return <span className={`fit-badge fit-${verdict}`}>{FIT_LABELS[verdict]}</span>;
}

// ---------------------------------------------------------------------------
// On this PC
// ---------------------------------------------------------------------------

export function InstalledSection() {
  const models = useModels((s) => s.ollamaModels);
  const reachable = useModels((s) => s.ollamaReachable);
  if (!reachable) return null; // the status card already explains what to do

  const remove = async (name: string) => {
    const ok = await confirm(
      `Delete ${name} from this PC? You'd need to download it again to use it.`,
      { title: "Delete model", kind: "warning" },
    );
    if (!ok) return;
    try {
      await ollamaDelete(useSettings.getState().settings.ollamaBaseUrl, name);
    } catch (error) {
      // ollama_delete verifies removal afterwards — surface its message.
      useUi.getState().showToast(String(error));
    }
    void useModels.getState().refreshOllama();
  };

  return (
    <section className="models-section">
      <h2>On this PC</h2>
      {models.length === 0 ? (
        <p className="models-note">Nothing installed yet — pick a model from the library below.</p>
      ) : (
        <div className="installed-list">
          {models.map((m) => (
            <div className="installed-row" key={m.name}>
              <BrandLogo name={m.name} size={20} />
              <div className="installed-info">
                <span className="installed-name">{m.name}</span>
                <span className="installed-chips">
                  {m.paramSize && <span className="chip">{m.paramSize}</span>}
                  {m.quantization && <span className="chip">{m.quantization}</span>}
                  {m.family && <span className="chip">{m.family}</span>}
                </span>
              </div>
              <span className="installed-size">{formatBytes(m.sizeBytes)}</span>
              <button
                type="button"
                className="icon-button is-destructive"
                title={`Delete ${m.name}`}
                onClick={() => void remove(m.name)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Library (curated catalog)
// ---------------------------------------------------------------------------

function LibraryCard({
  model,
  specs,
  pull,
  installed,
}: {
  model: CuratedModel;
  specs: SystemSpecs | null;
  pull: PullState | undefined;
  installed: boolean;
}) {
  const verdict: FitVerdict = specs
    ? estimateFit(model.sizeBytes, specs.totalMemBytes)
    : "unknown";
  const pulling = pull !== undefined && !pull.error;
  return (
    <article className="library-card">
      <div className="card-head">
        <BrandLogo name={model.name} size={20} />
        <span className="card-name">{model.name}</span>
        {model.isNew && <span className="chip is-new">New</span>}
      </div>
      <p className="card-blurb">{model.blurb}</p>
      <div className="card-foot">
        <span className="card-size">{model.approxSize}</span>
        <FitBadge verdict={verdict} />
        <span className="card-action">
          {installed ? (
            <span className="card-installed">
              <Check size={14} />
              <span>Installed</span>
            </span>
          ) : pulling ? null : (
            <button
              type="button"
              className="download-button"
              onClick={() => startPull(model.name)}
            >
              <Download size={13} />
              <span>Download</span>
            </button>
          )}
        </span>
      </div>
      {pull &&
        (pull.error ? <p className="pull-error">{pull.error}</p> : <PullProgress pull={pull} />)}
    </article>
  );
}

export function LibrarySection() {
  const [category, setCategory] = useState<string>(CURATED_CATEGORIES[0]?.name ?? "");
  const [specs, setSpecs] = useState<SystemSpecs | null>(null);
  const pulls = useModels((s) => s.pulls);
  const ollamaModels = useModels((s) => s.ollamaModels);

  // One fetch per visit — total RAM doesn't change under us.
  useEffect(() => {
    systemSpecs().then(setSpecs).catch(() => setSpecs(null));
  }, []);

  // Ollama reports "gemma3:latest" for a plain "gemma3" pull — match both.
  const installed = useMemo(() => {
    const names = new Set<string>();
    for (const m of ollamaModels) {
      names.add(m.name);
      names.add(m.name.replace(/:latest$/, ""));
    }
    return names;
  }, [ollamaModels]);

  const active =
    CURATED_CATEGORIES.find((c) => c.name === category) ?? CURATED_CATEGORIES[0];

  return (
    <section className="models-section">
      <h2>Library</h2>
      <div className="category-pills" role="tablist">
        {CURATED_CATEGORIES.map((c) => (
          <button
            key={c.name}
            type="button"
            role="tab"
            aria-selected={c.name === active?.name}
            className={"pill" + (c.name === active?.name ? " is-active" : "")}
            onClick={() => setCategory(c.name)}
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="library-grid">
        {active?.models.map((m) => (
          <LibraryCard
            key={m.name}
            model={m}
            specs={specs}
            pull={pulls[m.name]}
            installed={installed.has(m.name)}
          />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pull by name
// ---------------------------------------------------------------------------

export function PullByName() {
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const pull = useModels((s) => (submitted !== null ? s.pulls[submitted] : undefined));
  const pulling = pull !== undefined && !pull.error;

  const submit = () => {
    const tag = value.trim();
    if (!tag || pulling) return;
    setSubmitted(tag);
    startPull(tag);
  };

  return (
    <section className="models-section">
      <h2>Pull by name</h2>
      <p className="models-note">Grab any model from the Ollama library by its exact tag.</p>
      <div className="pull-row">
        <input
          value={value}
          placeholder="e.g. gemma3:4b"
          spellCheck={false}
          disabled={pulling}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button
          type="button"
          className="download-button"
          disabled={pulling || !value.trim()}
          onClick={submit}
        >
          <Download size={13} />
          <span>Pull</span>
        </button>
      </div>
      {pull &&
        (pull.error ? <p className="pull-error">{pull.error}</p> : <PullProgress pull={pull} />)}
    </section>
  );
}
