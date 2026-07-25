// Network: the outbound proxy. The settings store live-applies setProxy to
// the Rust HTTP layer on every change, but it swallows the result — so this
// pane re-validates on commit (blur/Enter) to catch the one failure mode
// that wiring hides: an address Rust rejects, leaving traffic on the OLD
// route while the field shows the new one. The test button proves the
// current route end-to-end with one real HTTPS request.

import { useState } from "react";
import Button from "../../common/Button";
import Field from "../../common/Field";
import Switch from "../../common/Switch";
import { fetchTextUrl, setProxy } from "../../../core/ipc";
import { useSettings } from "../../../state/settings";

/** The standard tiny connectivity probe — a 204 with no body. */
const TEST_URL = "https://www.gstatic.com/generate_204";

type TestState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ok"; ms: number }
  | { status: "failed"; message: string };

export default function NetworkPane() {
  const proxyEnabled = useSettings((s) => s.settings.proxyEnabled);
  const proxyUrl = useSettings((s) => s.settings.proxyUrl);
  const update = useSettings((s) => s.update);
  const [parseError, setParseError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  const commitUrl = async () => {
    if (!proxyEnabled || !proxyUrl.trim()) {
      setParseError(null);
      return;
    }
    try {
      await setProxy(proxyUrl);
      setParseError(null);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
    }
  };

  const runTest = async () => {
    setTest({ status: "running" });
    const started = Date.now();
    try {
      await fetchTextUrl(TEST_URL);
      setTest({ status: "ok", ms: Date.now() - started });
    } catch (e) {
      setTest({ status: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <>
      <div className="pane-header">
        <div className="pane-title">Network</div>
        <div className="pane-sub">Route Eaon's traffic through a proxy.</div>
      </div>

      <div className="settings-card">
        <Field label="Use a proxy" hint="Applies to all of Eaon's network traffic.">
          <Switch
            checked={proxyEnabled}
            onChange={(proxyEnabled) => {
              update({ proxyEnabled });
              setParseError(null);
              setTest({ status: "idle" });
            }}
          />
        </Field>
        <div className="settings-row" style={{ marginTop: 8 }}>
          <input
            className="settings-input settings-grow"
            placeholder="http://127.0.0.1:8080"
            value={proxyUrl}
            disabled={!proxyEnabled}
            aria-label="Proxy URL"
            onChange={(e) => {
              update({ proxyUrl: e.target.value });
              setParseError(null);
            }}
            onBlur={() => void commitUrl()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitUrl();
            }}
          />
        </div>
        {parseError && <div className="settings-error">{parseError}</div>}
      </div>

      <div className="settings-card">
        <Field
          label="Test connection"
          hint={
            proxyEnabled
              ? "Sends one HTTPS request through the proxy."
              : "Sends one HTTPS request directly (no proxy)."
          }
        >
          <Button size="sm" loading={test.status === "running"} onClick={() => void runTest()}>
            Test
          </Button>
        </Field>
        {test.status === "ok" && (
          <div className="settings-ok">Working — reached the internet in {test.ms} ms.</div>
        )}
        {test.status === "failed" && <div className="settings-error">{test.message}</div>}
      </div>
    </>
  );
}
