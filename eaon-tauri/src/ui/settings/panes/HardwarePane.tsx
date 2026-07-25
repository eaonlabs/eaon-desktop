// Hardware: what Rust's system_specs sees. The Models library uses the same
// numbers for its will-it-fit RAM estimates.

import { useEffect, useState } from "react";
import { systemSpecs } from "../../../core/ipc";
import type { SystemSpecs } from "../../../core/types";
import { formatBytes } from "../../../core/utils";

function prettyOs(os: string): string {
  const lowered = os.toLowerCase();
  if (lowered.includes("windows")) return "Windows";
  if (lowered.includes("linux")) return "Linux";
  if (lowered.includes("mac") || lowered.includes("darwin")) return "macOS";
  return os;
}

export default function HardwarePane() {
  const [specs, setSpecs] = useState<SystemSpecs | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    systemSpecs()
      .then(setSpecs)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <>
      <div className="pane-header">
        <div className="pane-title">Hardware</div>
        <div className="pane-sub">The Models library uses this to estimate what fits.</div>
      </div>

      <div className="settings-card">
        {error ? (
          <div className="settings-error" style={{ marginTop: 0 }}>{error}</div>
        ) : !specs ? (
          <div className="settings-note" style={{ marginTop: 0 }}>Reading system info…</div>
        ) : (
          <table className="settings-table">
            <tbody>
              <tr>
                <td>Operating system</td>
                <td className="num">{prettyOs(specs.os)}</td>
              </tr>
              <tr>
                <td>Architecture</td>
                <td className="num">{specs.arch}</td>
              </tr>
              <tr>
                <td>CPU cores</td>
                <td className="num">{specs.cpuCores}</td>
              </tr>
              <tr>
                <td>Memory</td>
                <td className="num">{formatBytes(specs.totalMemBytes)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
