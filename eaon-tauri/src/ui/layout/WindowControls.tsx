// Minimize / maximize / close for the frameless window. Order and glyph
// style follow Windows conventions (also fine on Linux CSD setups).

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";

export default function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win.isMaximized().then(setMaximized);
    void win.onResized(async () => setMaximized(await win.isMaximized())).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const win = getCurrentWindow();
  return (
    <div className="window-controls">
      <button
        className="window-control"
        onClick={() => void win.minimize()}
        aria-label="Minimize"
      >
        <Minus size={14} />
      </button>
      <button
        className="window-control"
        onClick={() => void win.toggleMaximize()}
        aria-label={maximized ? "Restore" : "Maximize"}
      >
        {maximized ? <Copy size={12} style={{ transform: "scaleX(-1)" }} /> : <Square size={12} />}
      </button>
      <button
        className="window-control window-control-close"
        onClick={() => void win.close()}
        aria-label="Close"
      >
        <X size={15} />
      </button>
    </div>
  );
}
