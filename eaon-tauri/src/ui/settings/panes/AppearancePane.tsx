// Appearance: theme, text size, accent, UI font, and the two chat-look
// toggles. Every change lands through settings.update, which also stamps
// the DOM (applyAppearance) — so the whole app restyles live.

import { useMemo, useState } from "react";
import { ChevronDown, Check, RotateCcw, Search } from "lucide-react";
import Switch from "../../common/Switch";
import { ACCENT_OPTIONS, FONT_OPTIONS } from "../../../core/catalog";
import { DEFAULT_SETTINGS } from "../../../core/persistence";
import type { FontSizeChoice, ThemeChoice } from "../../../core/types";
import { useSettings } from "../../../state/settings";

const THEMES: readonly ThemeChoice[] = ["Light", "Dark", "System"];
const SIZES: readonly FontSizeChoice[] = ["Small", "Medium", "Large"];

function PillSelect<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="pill-select-wrap">
      <select
        className="settings-pill-select"
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <ChevronDown size={14} className="pill-select-chevron" aria-hidden />
    </div>
  );
}

/** Black or white — whichever reads clearly on top of an arbitrary accent
 *  swatch (relative luminance, not a design token: this is contrast math
 *  against a user-picked color, not app chrome). */
function checkColorFor(hex: string): string {
  const n = hex.replace("#", "");
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#000" : "#fff";
}

/** "Default" isn't one color, it's the app spreading a palette across
 *  sections — shown as a wheel of the same real accent colors instead of a
 *  flat swatch, so its swatch actually communicates what it does. */
const DEFAULT_WHEEL = (() => {
  const hues = ACCENT_OPTIONS.filter((a) => a.id !== "default" && a.id !== "white").map(
    (a) => a.color,
  );
  return `conic-gradient(from 0deg, ${[...hues, hues[0]].join(", ")})`;
})();

export default function AppearancePane() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const [fontQuery, setFontQuery] = useState("");

  // Grouped so the list reads as two real categories rather than 17 names in
  // a row — and so the consequence of picking a mono face (the whole app goes
  // monospaced) is visible before you click, not a surprise after.
  const fontGroups = useMemo(() => {
    const q = fontQuery.trim().toLowerCase();
    const matches = q ? FONT_OPTIONS.filter((f) => f.label.toLowerCase().includes(q)) : FONT_OPTIONS;
    return [
      { key: "sans", label: "Sans-serif", fonts: matches.filter((f) => f.kind === "sans") },
      { key: "mono", label: "Monospaced", fonts: matches.filter((f) => f.kind === "mono") },
    ].filter((group) => group.fonts.length > 0);
  }, [fontQuery]);
  const matchCount = fontGroups.reduce((n, g) => n + g.fonts.length, 0);

  const resetAppearance = () =>
    update({
      theme: DEFAULT_SETTINGS.theme,
      fontSize: DEFAULT_SETTINGS.fontSize,
      accentColorId: DEFAULT_SETTINGS.accentColorId,
      fontId: DEFAULT_SETTINGS.fontId,
      coloredUserBubble: DEFAULT_SETTINGS.coloredUserBubble,
      showTokenSpeed: DEFAULT_SETTINGS.showTokenSpeed,
    });

  return (
    <>
      <div className="pane-header">
        <div className="pane-title">Appearance</div>
        <div className="pane-sub">Make Eaon look the way you like.</div>
      </div>

      <div className="settings-section-label">Theme</div>
      <div className="settings-card">
        <div className="settings-detail-row">
          <div className="row-text">
            <div className="row-title">Appearance</div>
            <div className="row-desc">Choose how Eaon looks.</div>
          </div>
          <PillSelect value={settings.theme} options={THEMES} onChange={(theme) => update({ theme })} />
        </div>
        <div className="settings-detail-row">
          <div className="row-text">
            <div className="row-title">Font Size</div>
            <div className="row-desc">Adjust the app's font size.</div>
          </div>
          <PillSelect
            value={settings.fontSize}
            options={SIZES}
            onChange={(fontSize) => update({ fontSize })}
          />
        </div>
        <div className="settings-detail-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
          <div className="row-text">
            <div className="row-title">Accent Color</div>
            <div className="row-desc">
              Used for buttons, links, and selection states. "Default" spreads a set of colors
              across the app instead of using one; pick a single color to make everything match.
            </div>
          </div>
          <div className="swatch-row" style={{ marginTop: 14 }}>
            {ACCENT_OPTIONS.map((accent) => {
              const selected = accent.id === settings.accentColorId;
              const isDefault = accent.id === "default";
              return (
                <button
                  key={accent.id}
                  className="swatch"
                  style={{ background: isDefault ? DEFAULT_WHEEL : accent.color }}
                  aria-label={`Accent ${accent.id}`}
                  aria-pressed={selected}
                  onClick={() => update({ accentColorId: accent.id })}
                >
                  {selected && (
                    <Check
                      size={13}
                      strokeWidth={3}
                      className="swatch-check"
                      style={{ color: isDefault ? "#fff" : checkColorFor(accent.color) }}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="settings-section-label">Font</div>
      <div className="settings-card">
        <div className="row-title">Typeface</div>
        <div className="row-desc">
          Sets the font across the whole app. Every one is built in, so they all work offline.
          Pick a monospaced face and code stays in it too; pick a sans-serif and code keeps its
          own monospaced font.
        </div>
        <div className="font-search" style={{ marginTop: 14 }}>
          <Search size={14} aria-hidden />
          <input
            value={fontQuery}
            onChange={(e) => setFontQuery(e.target.value)}
            placeholder={`Search ${FONT_OPTIONS.length} fonts…`}
            aria-label="Search fonts"
          />
        </div>
        <div className="font-list">
          {matchCount === 0 && <div className="font-row-empty">No fonts match "{fontQuery}"</div>}
          {fontGroups.map((group) => (
            <div key={group.key}>
              <div className="settings-section-label" style={{ margin: "6px 0 4px", padding: "0 6px" }}>
                {group.label}
              </div>
              {group.fonts.map((font) => (
                <button
                  key={font.id}
                  className={font.id === settings.fontId ? "font-row selected" : "font-row"}
                  // Each row previews itself in its own face — the only way to
                  // choose a typeface is to see it.
                  style={{ fontFamily: font.stack }}
                  onClick={() => update({ fontId: font.id })}
                >
                  {font.label}
                  {font.id === settings.fontId && <Check size={14} aria-hidden />}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="settings-section-label">Chat</div>
      <div className="settings-card">
        <div className="settings-detail-row">
          <div className="row-text">
            <div className="row-title">Colored user bubble</div>
            <div className="row-desc">Tint your own messages with the accent color instead of a neutral gray.</div>
          </div>
          <Switch
            checked={settings.coloredUserBubble}
            onChange={(coloredUserBubble) => update({ coloredUserBubble })}
          />
        </div>
        <div className="settings-detail-row">
          <div className="row-text">
            <div className="row-title">Show token speed</div>
            <div className="row-desc">Display tokens/sec and token count inline below assistant messages.</div>
          </div>
          <Switch
            checked={settings.showTokenSpeed}
            onChange={(showTokenSpeed) => update({ showTokenSpeed })}
          />
        </div>
      </div>

      <button className="settings-reset-link" onClick={resetAppearance}>
        <RotateCcw size={13} aria-hidden />
        Reset appearance to defaults
      </button>
    </>
  );
}
