// Global sampling parameters. Each field is independently opt-in — the off
// state means "don't send the field at all", which matters because many
// reasoning models reject an explicit temperature outright.

import Switch from "../../common/Switch";
import type { ModelParams } from "../../../core/types";
import { useSettings } from "../../../state/settings";

type ValueKey = "temperature" | "topP" | "maxTokens" | "frequencyPenalty" | "presencePenalty";
type EnabledKey =
  | "temperatureEnabled"
  | "topPEnabled"
  | "maxTokensEnabled"
  | "frequencyPenaltyEnabled"
  | "presencePenaltyEnabled";

interface RowSpec {
  valueKey: ValueKey;
  enabledKey: EnabledKey;
  label: string;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
}

const ROWS: RowSpec[] = [
  { valueKey: "temperature", enabledKey: "temperatureEnabled", label: "Temperature", min: 0, max: 2, step: 0.05 },
  { valueKey: "topP", enabledKey: "topPEnabled", label: "Top P", min: 0, max: 1, step: 0.01 },
  { valueKey: "maxTokens", enabledKey: "maxTokensEnabled", label: "Max tokens", min: 1, max: 32768, step: 1, integer: true },
  { valueKey: "frequencyPenalty", enabledKey: "frequencyPenaltyEnabled", label: "Frequency penalty", min: -2, max: 2, step: 0.05 },
  { valueKey: "presencePenalty", enabledKey: "presencePenaltyEnabled", label: "Presence penalty", min: -2, max: 2, step: 0.05 },
];

export default function ParamsPane() {
  const params = useSettings((s) => s.settings.modelParams);
  const update = useSettings((s) => s.update);

  const patch = (change: Partial<ModelParams>) =>
    update({ modelParams: { ...params, ...change } });

  const setValue = (row: RowSpec, raw: number) => {
    if (!Number.isFinite(raw)) return;
    const clamped = Math.min(row.max, Math.max(row.min, raw));
    patch({ [row.valueKey]: row.integer ? Math.round(clamped) : clamped });
  };

  return (
    <>
      <div className="pane-header">
        <div className="pane-title">Model parameters</div>
        <div className="pane-sub">
          Off means the field isn't sent at all — some models reject explicit values.
        </div>
      </div>

      <div className="settings-card">
        {ROWS.map((row) => {
          const enabled = params[row.enabledKey];
          const value = params[row.valueKey];
          return (
            <div key={row.valueKey} className={enabled ? "param-row" : "param-row off"}>
              <Switch
                checked={enabled}
                onChange={(on) => patch({ [row.enabledKey]: on })}
                aria-label={`Send ${row.label}`}
              />
              <div className="param-label">{row.label}</div>
              <input
                type="range"
                min={row.min}
                max={row.max}
                step={row.step}
                value={value}
                disabled={!enabled}
                onChange={(e) => setValue(row, Number(e.target.value))}
              />
              <input
                className="settings-input-sm"
                type="number"
                min={row.min}
                max={row.max}
                step={row.step}
                value={value}
                disabled={!enabled}
                onChange={(e) => setValue(row, Number(e.target.value))}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}
