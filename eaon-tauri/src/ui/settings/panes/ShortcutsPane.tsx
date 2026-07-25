// Shortcuts: a static reference table. Bindings are fixed (Ctrl on the
// platforms this app ships to), so this is documentation, not configuration.

const SHORTCUTS: Array<{ keys: string[]; action: string }> = [
  { keys: ["Ctrl", "N"], action: "New chat" },
  { keys: ["Ctrl", "K"], action: "Search & commands" },
  { keys: ["Ctrl", "\\"], action: "Toggle sidebar" },
  { keys: ["Enter"], action: "Send message" },
  { keys: ["Shift", "Enter"], action: "New line" },
  { keys: ["Shift", "Tab"], action: "Agent: Sandboxed / Auto" },
];

export default function ShortcutsPane() {
  return (
    <>
      <div className="pane-header">
        <div className="pane-title">Shortcuts</div>
        <div className="pane-sub">Everything Eaon answers to from the keyboard.</div>
      </div>

      <div className="settings-card">
        <table className="settings-table">
          <tbody>
            {SHORTCUTS.map((shortcut) => (
              <tr key={shortcut.action}>
                <td>{shortcut.action}</td>
                <td style={{ textAlign: "right" }}>
                  {shortcut.keys.map((key, i) => (
                    <span key={key}>
                      {i > 0 && <span style={{ margin: "0 3px" }}>+</span>}
                      <kbd>{key}</kbd>
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
