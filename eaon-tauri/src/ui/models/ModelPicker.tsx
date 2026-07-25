// The composer's model selector — a self-contained trigger + popover pair.
// Entries arrive pre-resolved (nicknames, hidden keys) from
// useModels.entries(); this component only searches, groups, favorites, and
// picks. Anchored above the composer like the Mac picker.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  Search,
  Settings,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import type { ModelEntry } from "../../core/types";
import { activeTrial } from "../../chat/modelRouting";
import { useModels } from "../../state/models";
import { useSettings } from "../../state/settings";
import { EAON_PROVIDER_ID, FREE_TRIAL_PROVIDER_ID, useUi } from "../../state/ui";
import BrandLogo from "./BrandLogo";
import "./models.css";

interface Group {
  id: string;
  label: string;
  entries: ModelEntry[];
}

function matches(entry: ModelEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    entry.display.toLowerCase().includes(q) || entry.requestId.toLowerCase().includes(q)
  );
}

export default function ModelPicker() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const settings = useSettings((s) => s.settings);
  const selectedKey = useModels((s) => s.selectedModelKey);
  const hostedModels = useModels((s) => s.hostedModels);
  const hostedError = useModels((s) => s.hostedError);
  const ollamaModels = useModels((s) => s.ollamaModels);
  const ollamaReachable = useModels((s) => s.ollamaReachable);

  // entries() derives from hosted + ollama + settings — recompute only when
  // those inputs change, not on every open/close/keystroke render.
  const all = useMemo(
    () => useModels.getState().entries(),
    [hostedModels, ollamaModels, settings],
  );
  const selected = all.find((e) => e.key === selectedKey) ?? null;

  const filtered = useMemo(() => all.filter((e) => matches(e, query)), [all, query]);
  const favorites = useMemo(
    () => filtered.filter((e) => settings.favorites.includes(e.key)),
    [filtered, settings.favorites],
  );

  const groups: Group[] = useMemo(() => {
    const eaon: Group = { id: "eaon", label: "Eaon", entries: [] };
    const freeTrial: Group = { id: "freeTrial", label: "Free Trial", entries: [] };
    const local: Group = { id: "local", label: "Local", entries: [] };
    const custom = new Map<string, Group>();
    for (const e of filtered) {
      if (e.provider.kind === "eaon") eaon.entries.push(e);
      else if (e.provider.kind === "freeTrial") freeTrial.entries.push(e);
      else if (e.provider.kind === "ollama") local.entries.push(e);
      else {
        let group = custom.get(e.provider.configId);
        if (!group) {
          group = { id: `custom:${e.provider.configId}`, label: e.provider.configName, entries: [] };
          custom.set(e.provider.configId, group);
        }
        group.entries.push(e);
      }
    }
    return [eaon, freeTrial, ...custom.values(), local];
  }, [filtered]);

  // While searching, collapse state is ignored so matches are never hidden.
  const searching = query.trim().length > 0;
  const isCollapsed = (id: string) => !searching && collapsed.has(id);
  const visibleRows = useMemo(() => {
    const rows: ModelEntry[] = [...favorites];
    for (const g of groups) if (!isCollapsed(g.id)) rows.push(...g.entries);
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favorites, groups, collapsed, searching]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  useEffect(() => setActiveIndex(0), [query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, visibleRows]);

  const pick = (key: string) => {
    useModels.getState().setSelected(key);
    setOpen(false);
  };

  const toggleFavorite = (key: string) => {
    const { settings: current, update } = useSettings.getState();
    const favoritesNext = current.favorites.includes(key)
      ? current.favorites.filter((k) => k !== key)
      : [...current.favorites, key];
    update({ favorites: favoritesNext });
  };

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const jumpToSettings = (target: "eaon" | "freeTrial" | "local") => {
    setOpen(false);
    if (target === "local") useUi.getState().openSettings("local");
    else useUi.getState().openSettings("provider", target === "eaon" ? EAON_PROVIDER_ID : FREE_TRIAL_PROVIDER_ID);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(visibleRows.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = visibleRows[activeIndex];
      if (row) pick(row.key);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
    }
  };

  // Rows render in exactly visibleRows order; the counter keeps keyboard
  // indexes and painted rows in lockstep without a second bookkeeping pass.
  let rowIndex = -1;
  const renderRow = (entry: ModelEntry) => {
    rowIndex += 1;
    const index = rowIndex;
    const favorite = settings.favorites.includes(entry.key);
    return (
      <button
        key={`${index}:${entry.key}`}
        type="button"
        role="option"
        aria-selected={entry.key === selectedKey}
        className="picker-row"
        data-active={index === activeIndex}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => pick(entry.key)}
      >
        <BrandLogo name={entry.requestId} size={18} />
        <span className="picker-row-name">{entry.display}</span>
        {entry.tier ? <span className="picker-chip">{entry.tier}</span> : null}
        {entry.supportsVision && (
          <Eye size={13} className="picker-eye" aria-label="Understands images" />
        )}
        <span
          className={"picker-star" + (favorite ? " is-fav" : "")}
          title={favorite ? "Remove from favorites" : "Add to favorites"}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite(entry.key);
          }}
        >
          <Star size={13} fill={favorite ? "currentColor" : "none"} />
        </span>
        {entry.key === selectedKey && <Check size={14} className="picker-check" />}
      </button>
    );
  };

  const needsEaonSetup = hostedModels.length === 0 && !settings.eaonApiKey;
  const needsFreeTrialSetup =
    hostedModels.length === 0 && activeTrial(settings.trialCredential) === null;

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="model-picker-trigger"
        title="Choose a model"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {selected && <BrandLogo name={selected.requestId} size={16} />}
        <span className="trigger-name">{selected?.display ?? "Choose a model"}</span>
        <ChevronDown size={14} className="trigger-chevron" />
      </button>

      {open && (
        <div className="model-popover" role="listbox" onKeyDown={onKeyDown}>
          <div className="popover-search">
            <Search size={13} />
            <input
              ref={searchRef}
              value={query}
              placeholder="Search models"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="popover-list" ref={listRef}>
            {favorites.length > 0 && (
              <div className="popover-group">
                <div className="popover-header is-static">
                  <Star size={12} fill="currentColor" />
                  <span>Favorites</span>
                </div>
                {favorites.map(renderRow)}
              </div>
            )}

            {groups.map((group) => (
              <div className="popover-group" key={group.id}>
                <button
                  type="button"
                  className="popover-header"
                  onClick={() => toggleCollapse(group.id)}
                >
                  {isCollapsed(group.id) ? (
                    <ChevronRight size={12} />
                  ) : (
                    <ChevronDown size={12} />
                  )}
                  <span>{group.label}</span>
                  <span className="header-count">{group.entries.length}</span>
                </button>

                {!isCollapsed(group.id) && group.entries.map(renderRow)}

                {!isCollapsed(group.id) &&
                  !searching &&
                  group.id === "eaon" &&
                  group.entries.length === 0 &&
                  (needsEaonSetup ? (
                    <button
                      type="button"
                      className="popover-hint"
                      onClick={() => jumpToSettings("eaon")}
                    >
                      Add your Eaon API key
                    </button>
                  ) : hostedError ? (
                    <div className="popover-hint is-muted">Couldn't load hosted models</div>
                  ) : null)}

                {!isCollapsed(group.id) &&
                  !searching &&
                  group.id === "freeTrial" &&
                  group.entries.length === 0 &&
                  (needsFreeTrialSetup ? (
                    <button
                      type="button"
                      className="popover-hint"
                      onClick={() => jumpToSettings("freeTrial")}
                    >
                      Start the Free Week
                    </button>
                  ) : hostedError ? (
                    <div className="popover-hint is-muted">Couldn't load hosted models</div>
                  ) : null)}

                {!isCollapsed(group.id) && !searching && group.id === "local" && !ollamaReachable && (
                  <div className="popover-hint is-muted">
                    <span>Ollama isn't running</span>
                    <button
                      type="button"
                      className="hint-gear"
                      title="Local model settings"
                      onClick={() => jumpToSettings("local")}
                    >
                      <Settings size={12} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <button
            type="button"
            className="popover-footer"
            onClick={() => jumpToSettings("eaon")}
          >
            <SlidersHorizontal size={13} />
            <span>Manage models</span>
          </button>
        </div>
      )}
    </div>
  );
}
