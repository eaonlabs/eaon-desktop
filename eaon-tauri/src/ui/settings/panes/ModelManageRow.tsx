// One model row in a provider's "Models" management card: id, vision badge,
// display name, and the three actions the Mac app's provider pages offer —
// favorite, rename (nickname), hide/restore. Shared by the Eaon API page and
// every BYOK provider page so the three actions behave identically.

import { useState } from "react";
import { Check, Eye, Pencil, Star, Trash2, X } from "lucide-react";
import type { ModelEntry } from "../../../core/types";
import { useSettings } from "../../../state/settings";

export default function ModelManageRow({ entry }: { entry: ModelEntry }) {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(entry.display);

  const favorite = settings.favorites.includes(entry.key);
  const hidden = settings.hiddenModelKeys.includes(entry.key);

  const toggleFavorite = () => {
    const next = favorite
      ? settings.favorites.filter((k) => k !== entry.key)
      : [...settings.favorites, entry.key];
    update({ favorites: next });
  };

  const toggleHidden = () => {
    const next = hidden
      ? settings.hiddenModelKeys.filter((k) => k !== entry.key)
      : [...settings.hiddenModelKeys, entry.key];
    update({ hiddenModelKeys: next });
  };

  const commitRename = () => {
    const name = draft.trim();
    const nicknames = { ...settings.nicknames };
    if (name && name !== entry.requestId) nicknames[entry.key] = name;
    else delete nicknames[entry.key];
    update({ nicknames });
    setRenaming(false);
  };

  return (
    <div className="model-row" style={hidden ? { opacity: 0.5 } : undefined}>
      <div className="model-row-text">
        {renaming ? (
          <div className="model-rename-row">
            <input
              className="settings-input"
              value={draft}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                else if (e.key === "Escape") {
                  setDraft(entry.display);
                  setRenaming(false);
                }
              }}
            />
            <button className="icon-btn" aria-label="Save name" onClick={commitRename}>
              <Check size={14} />
            </button>
            <button
              className="icon-btn"
              aria-label="Cancel"
              onClick={() => {
                setDraft(entry.display);
                setRenaming(false);
              }}
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <>
            <div className="model-row-id">
              {entry.requestId}
              {entry.supportsVision && <Eye size={13} className="model-row-eye" aria-label="Vision-capable" />}
            </div>
            <div className="model-row-name">{entry.display}</div>
          </>
        )}
      </div>
      {!renaming && (
        <div className="model-row-actions">
          <button
            className={favorite ? "icon-btn lit" : "icon-btn"}
            aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
            title={favorite ? "Remove from favorites" : "Add to favorites"}
            onClick={toggleFavorite}
          >
            <Star size={14} fill={favorite ? "currentColor" : "none"} />
          </button>
          <button
            className="icon-btn"
            aria-label="Rename"
            title="Rename"
            onClick={() => {
              setDraft(entry.display);
              setRenaming(true);
            }}
          >
            <Pencil size={13} />
          </button>
          <button
            className={hidden ? "icon-btn lit" : "icon-btn"}
            aria-label={hidden ? "Restore" : "Hide"}
            title={hidden ? "Restore" : "Hide"}
            onClick={toggleHidden}
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
