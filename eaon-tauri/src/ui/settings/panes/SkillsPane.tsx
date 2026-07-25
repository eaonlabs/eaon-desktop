// Skills: installed list plus the three install paths (manual, GitHub URL,
// import from a local Claude Code setup). Parsing follows the SKILL.md
// convention via core/protocol/skills — errors surface inline, calmly.

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import Button from "../../common/Button";
import Dialog from "../../common/Dialog";
import Switch from "../../common/Switch";
import {
  candidateRawURLs,
  normalizeSkillName,
  parseSkill,
  STARTER_SKILLS,
} from "../../../core/protocol/skills";
import { fetchTextUrl, scanClaudeSkills } from "../../../core/ipc";
import type { Skill, SkillSource } from "../../../core/types";
import { uid } from "../../../core/utils";
import { useSettings } from "../../../state/settings";
import { useUi } from "../../../state/ui";

const SOURCE_LABELS: Record<SkillSource["kind"], string> = {
  starter: "Starter",
  github: "GitHub",
  localImport: "Claude Code",
  manual: "Manual",
};

function makeSkill(name: string, summary: string, instructions: string, source: SkillSource): Skill {
  return { id: uid(), name, summary, instructions, source, isEnabled: true, installedAt: Date.now() };
}

interface ClaudeRow {
  path: string;
  name: string;
  summary: string;
  instructions: string;
  checked: boolean;
}

type AddTab = "manual" | "github" | "claude";

function AddSkillDialog({
  open,
  onClose,
  installedNames,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  installedNames: string[];
  onAdd: (skills: Skill[]) => void;
}) {
  const [tab, setTab] = useState<AddTab>("manual");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [instructions, setInstructions] = useState("");
  const [url, setUrl] = useState("");
  const [claudeRows, setClaudeRows] = useState<ClaudeRow[] | null>(null);

  // Fresh dialog every open — stale drafts from a previous add are confusing.
  useEffect(() => {
    if (!open) return;
    setTab("manual");
    setError(null);
    setName("");
    setSummary("");
    setInstructions("");
    setUrl("");
    setClaudeRows(null);
  }, [open]);

  // Scan the local Claude Code install lazily, only when that tab is chosen.
  useEffect(() => {
    if (!open || tab !== "claude" || claudeRows !== null) return;
    setBusy(true);
    scanClaudeSkills()
      .then((candidates) => {
        const rows: ClaudeRow[] = [];
        for (const candidate of candidates) {
          try {
            const parsed = parseSkill(candidate.text);
            if (installedNames.includes(parsed.name)) continue;
            rows.push({ path: candidate.path, ...parsed, checked: true });
          } catch {
            // Not a parseable SKILL.md — silently skip; this is a discovery
            // scan, not a validation report.
          }
        }
        setClaudeRows(rows);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [open, tab, claudeRows, installedNames]);

  const addManual = () => {
    const cleanName = normalizeSkillName(name);
    if (!cleanName || !summary.trim() || !instructions.trim()) {
      setError("A skill needs a name, a one-line summary, and instructions.");
      return;
    }
    if (installedNames.includes(cleanName)) {
      setError(`/${cleanName} is already installed.`);
      return;
    }
    onAdd([makeSkill(cleanName, summary.trim(), instructions.trim(), { kind: "manual" })]);
    onClose();
  };

  const addFromGitHub = async () => {
    setError(null);
    const candidates = candidateRawURLs(url);
    if (candidates.length === 0) {
      setError("That doesn't look like a GitHub URL. Paste a link to a repo or a SKILL.md file.");
      return;
    }
    setBusy(true);
    try {
      let lastError = "Couldn't find a SKILL.md at that address.";
      for (const candidate of candidates) {
        try {
          const parsed = parseSkill(await fetchTextUrl(candidate));
          if (installedNames.includes(parsed.name)) {
            setError(`/${parsed.name} is already installed.`);
            return;
          }
          onAdd([
            makeSkill(parsed.name, parsed.summary, parsed.instructions, {
              kind: "github",
              url: url.trim(),
            }),
          ]);
          onClose();
          return;
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
      }
      setError(lastError);
    } finally {
      setBusy(false);
    }
  };

  const importClaude = () => {
    const selected = (claudeRows ?? []).filter((row) => row.checked);
    onAdd(
      selected.map((row) =>
        makeSkill(row.name, row.summary, row.instructions, {
          kind: "localImport",
          path: row.path,
        }),
      ),
    );
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title="Add skill">
      <div className="tab-row">
        {(
          [
            ["manual", "Manual"],
            ["github", "From GitHub"],
            ["claude", "Import from Claude Code"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => {
              setTab(id);
              setError(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "manual" && (
        <>
          <div className="settings-row">
            <input
              className="settings-input"
              placeholder="Name — typed after / (e.g. code-review)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="settings-row">
            <input
              className="settings-input"
              placeholder="One-line summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>
          <div className="settings-row">
            <textarea
              className="settings-textarea"
              rows={6}
              placeholder="Instructions the model follows when you invoke this skill"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </div>
          <div className="settings-row" style={{ justifyContent: "flex-end" }}>
            <Button variant="primary" size="sm" onClick={addManual}>
              Add skill
            </Button>
          </div>
        </>
      )}

      {tab === "github" && (
        <>
          <div className="settings-row">
            <input
              className="settings-input settings-grow"
              placeholder="https://github.com/user/repo or a SKILL.md link"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addFromGitHub();
              }}
            />
            <Button variant="primary" size="sm" loading={busy} onClick={() => void addFromGitHub()}>
              Fetch
            </Button>
          </div>
          <div className="settings-note">
            Works with a repo link (looks for SKILL.md on main/master) or a direct file link.
          </div>
        </>
      )}

      {tab === "claude" && (
        <>
          {busy && <div className="settings-note">Looking for skills on this PC…</div>}
          {claudeRows !== null && claudeRows.length === 0 && !busy && (
            <div className="settings-note">
              No new importable skills found in your Claude Code folders.
            </div>
          )}
          {(claudeRows ?? []).map((row) => (
            <label key={row.path} className="check-row">
              <input
                type="checkbox"
                checked={row.checked}
                onChange={(e) =>
                  setClaudeRows(
                    (rows) =>
                      rows?.map((r) =>
                        r.path === row.path ? { ...r, checked: e.target.checked } : r,
                      ) ?? null,
                  )
                }
              />
              <span className="settings-chip">/{row.name}</span>
              <span className="item-sub" style={{ marginTop: 0 }}>
                {row.summary}
              </span>
            </label>
          ))}
          {claudeRows !== null && claudeRows.length > 0 && (
            <div className="settings-row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
              <Button
                variant="primary"
                size="sm"
                disabled={!claudeRows.some((r) => r.checked)}
                onClick={importClaude}
              >
                Import selected
              </Button>
            </div>
          )}
        </>
      )}

      {error && <div className="settings-error">{error}</div>}
    </Dialog>
  );
}

export default function SkillsPane() {
  const skills = useSettings((s) => s.settings.skills);
  const update = useSettings((s) => s.update);
  const showToast = useUi((s) => s.showToast);
  const [addOpen, setAddOpen] = useState(false);

  const addSkills = (added: Skill[]) => {
    if (added.length === 0) return;
    update({ skills: [...useSettings.getState().settings.skills, ...added] });
    showToast(added.length === 1 ? `/${added[0].name} added` : `${added.length} skills added`);
  };

  const setEnabled = (id: string, isEnabled: boolean) =>
    update({ skills: skills.map((s) => (s.id === id ? { ...s, isEnabled } : s)) });

  const remove = (id: string) => update({ skills: skills.filter((s) => s.id !== id) });

  const hasStarter = skills.some((s) => s.source.kind === "starter");
  const addStarters = () => {
    const installed = skills.map((s) => s.name);
    const starters: Skill[] = [];
    for (const text of STARTER_SKILLS) {
      try {
        const parsed = parseSkill(text);
        if (installed.includes(parsed.name)) continue;
        starters.push(makeSkill(parsed.name, parsed.summary, parsed.instructions, { kind: "starter" }));
      } catch {
        // A malformed bundled starter is a build bug, not a user problem.
      }
    }
    addSkills(starters);
  };

  return (
    <>
      <div className="pane-header">
        <div className="pane-title">Skills</div>
        <div className="pane-sub">
          Reusable instruction sets you invoke with /name at the start of a message.
        </div>
      </div>

      <div className="settings-card">
        {skills.length === 0 ? (
          <div className="settings-note" style={{ marginTop: 0 }}>
            No skills installed yet.
          </div>
        ) : (
          skills.map((skill) => (
            <div key={skill.id} className="item-row">
              <div className="item-main">
                <div className="item-title">
                  <span className="settings-chip">/{skill.name}</span>
                  <span className="tag-chip">{SOURCE_LABELS[skill.source.kind]}</span>
                </div>
                <div className="item-sub">{skill.summary}</div>
              </div>
              <div className="item-actions">
                <Switch
                  checked={skill.isEnabled}
                  onChange={(on) => setEnabled(skill.id, on)}
                  aria-label={`Enable /${skill.name}`}
                />
                <button className="icon-btn danger" aria-label="Remove skill" onClick={() => remove(skill.id)}>
                  <X size={14} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="settings-row" style={{ marginTop: 12 }}>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          Add skill
        </Button>
        {!hasStarter && (
          <Button variant="ghost" size="sm" onClick={addStarters}>
            Add starter skills
          </Button>
        )}
      </div>

      <AddSkillDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        installedNames={skills.map((s) => s.name)}
        onAdd={addSkills}
      />
    </>
  );
}
