// Custom instructions: one textarea, persisted on every keystroke through
// settings.update (the persist wiring debounces the disk write).

import { useSettings } from "../../../state/settings";

export default function InstructionsPane() {
  const customInstructions = useSettings((s) => s.settings.customInstructions);
  const update = useSettings((s) => s.update);

  return (
    <>
      <div className="pane-header">
        <div className="pane-title">Instructions</div>
        <div className="pane-sub">
          Added to every chat. Tell Eaon who you are and how it should respond.
        </div>
      </div>

      <div className="settings-card">
        <textarea
          className="settings-textarea"
          rows={8}
          placeholder="e.g. I'm a Python developer. Keep answers short and skip the pleasantries."
          value={customInstructions}
          onChange={(e) => update({ customInstructions: e.target.value })}
        />
        <div className="settings-charcount">{customInstructions.length} characters</div>
      </div>
    </>
  );
}
