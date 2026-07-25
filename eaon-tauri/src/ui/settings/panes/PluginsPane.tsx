// Plugins (MCP servers): the built-in, individually-verified catalog
// (pasted-token or OAuth sign-in, port of the Mac app's PluginsSettingsView)
// plus custom servers reachable by any URL. Connect/disconnect live, hand
// the connected tool list to the chat pipeline (chat/send owns the
// per-server tool registry) — every call still asks first unless Always
// Allow is on.

import { useState } from "react";
import { ChevronDown, ExternalLink, Loader2, Plus, TriangleAlert } from "lucide-react";
import Button from "../../common/Button";
import Dialog from "../../common/Dialog";
import Switch from "../../common/Switch";
import { MCP_CATALOG, type McpCatalogEntry } from "../../../core/mcpCatalog";
import { hasStoredCredential, useMcpConnections, type McpConnectionState } from "../../../state/mcpConnections";
import type { McpServer } from "../../../core/types";
import { uid } from "../../../core/utils";
import { useSettings } from "../../../state/settings";
import { openUrl } from "@tauri-apps/plugin-opener";

export default function PluginsPane() {
  return (
    <>
      <div className="pane-header">
        <div className="pane-title">Plugins</div>
        <div className="pane-sub">
          Connect outside services so models can read and act on your behalf, with your consent.
        </div>
      </div>

      <div className="settings-card">
        {MCP_CATALOG.map((entry, index) => (
          <CatalogRow key={entry.id} entry={entry} isFirst={index === 0} isLast={index === MCP_CATALOG.length - 1} />
        ))}
      </div>

      <CustomServersSection />
    </>
  );
}

// ---------------------------------------------------------------------------
// Built-in catalog
// ---------------------------------------------------------------------------

/** Mirrors the Mac app's statusTag switch exactly — needsManualClientId and
 *  failed show only the warning icon, no label text next to it. */
function statusLabel(state: McpConnectionState, hasNoTools: boolean): { text: string; warn: boolean; dot: boolean } | null {
  switch (state.status) {
    case "connected":
      return hasNoTools ? { text: "Connected, no tools", warn: true, dot: false } : { text: "Connected", warn: false, dot: true };
    default:
      return null;
  }
}

function isWarnOnly(state: McpConnectionState): boolean {
  return state.status === "needsManualClientId" || state.status === "failed";
}

function CatalogRow({ entry, isFirst, isLast }: { entry: McpCatalogEntry; isFirst: boolean; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const rawState = useMcpConnections((s) => s.stateFor(entry.id));
  // A stored credential with no runtime state yet is still mid-flight
  // through reconnectAllAtLaunch (it awaits each service in turn) — show
  // "connecting" for it too, not a bare "Connect" row that flips a moment
  // later once its turn comes up.
  const state: McpConnectionState =
    rawState.status === "disconnected" && hasStoredCredential(entry.id) ? { status: "connecting" } : rawState;
  const hasNoTools = state.status === "connected" && state.toolCount === 0;
  const label = statusLabel(state, hasNoTools);

  return (
    <div className="plugin-row" style={{ borderTop: isFirst ? "none" : undefined }}>
      <button
        type="button"
        className="plugin-row-header"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span className="plugin-badge">
          <img src={`/brand-logos/${entry.logoAssetName}`} alt="" draggable={false} />
        </span>
        <span className="plugin-row-text">
          <div className="plugin-row-name">{entry.displayName}</div>
          <div className="plugin-row-summary">{entry.summary}</div>
        </span>
        {state.status === "connecting" ? (
          <Loader2 size={15} className="btn-spin" style={{ color: "var(--text-muted)" }} aria-hidden />
        ) : isWarnOnly(state) ? (
          <TriangleAlert size={13} className="plugin-status-icon-only" aria-hidden />
        ) : label ? (
          <span className={`plugin-status${label.warn ? " warn" : ""}`}>
            {label.dot && <span className="plugin-status-dot" />}
            {label.warn && <TriangleAlert size={12} />}
            {label.text}
          </span>
        ) : null}
        <ChevronDown size={15} className={`plugin-chevron${expanded ? " open" : ""}`} />
      </button>
      {expanded && (
        <div className="plugin-row-body" style={{ borderBottom: isLast ? "none" : undefined }}>
          <CatalogRowBody entry={entry} state={state} hasNoTools={hasNoTools} />
        </div>
      )}
    </div>
  );
}

function CatalogRowBody({ entry, state, hasNoTools }: { entry: McpCatalogEntry; state: McpConnectionState; hasNoTools: boolean }) {
  const connectPastedToken = useMcpConnections((s) => s.connectPastedToken);
  const connectOAuth = useMcpConnections((s) => s.connectOAuth);
  const disconnect = useMcpConnections((s) => s.disconnect);
  const [tokenInput, setTokenInput] = useState("");
  const [clientIdInput, setClientIdInput] = useState("");

  if (state.status === "connected") {
    return (
      <>
        {hasNoTools && (
          <div className="settings-error" style={{ color: "var(--warning)" }}>
            Connected, but {entry.displayName} returned no tools — the model can't actually do anything with it yet.{" "}
            {entry.tokenHint ?? (entry.authMode === "oauth" ? "Try disconnecting and signing in again." : "Try disconnecting and reconnecting with a different token.")}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span className="settings-note" style={{ margin: 0 }}>
            {state.toolCount} tool{state.toolCount === 1 ? "" : "s"} available
          </span>
          <Button variant="danger" size="sm" onClick={() => void disconnect(entry)}>
            Disconnect
          </Button>
        </div>
      </>
    );
  }

  if (state.status === "connecting") {
    return (
      <div className="settings-note" style={{ margin: 0 }}>
        {entry.authMode === "oauth" ? "Waiting for sign-in to finish in your browser…" : "Verifying your token and listing available tools…"}
      </div>
    );
  }

  if (state.status === "needsManualClientId") {
    return (
      <>
        <div className="settings-note" style={{ margin: 0 }}>
          {entry.displayName} doesn't support automatic sign-in — you'll need to create a client ID once, yourself.
        </div>
        {entry.manualClientIdSetupURL && (
          <button type="button" className="plugin-link" onClick={() => void openUrl(entry.manualClientIdSetupURL!)}>
            Create a {entry.displayName} app <ExternalLink size={12} />
          </button>
        )}
        {entry.manualClientIdHint && <div className="settings-note" style={{ margin: 0, fontSize: 11.5 }}>{entry.manualClientIdHint}</div>}
        <div className="settings-row">
          <input
            className="settings-input settings-grow"
            placeholder="Paste the Client ID"
            value={clientIdInput}
            onChange={(e) => setClientIdInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && clientIdInput.trim()) void connectOAuth(entry, true, clientIdInput.trim());
            }}
          />
          <Button
            variant="primary"
            size="sm"
            disabled={!clientIdInput.trim()}
            onClick={() => void connectOAuth(entry, true, clientIdInput.trim())}
          >
            Continue
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      {state.status === "failed" && <div className="settings-error">{state.message}</div>}

      {entry.authMode === "oauth" ? (
        <>
          <Button variant="primary" size="sm" onClick={() => void connectOAuth(entry, true)} style={{ width: "fit-content" }}>
            Sign in to {entry.displayName}
          </Button>
          <div className="settings-note" style={{ margin: 0, fontSize: 11.5 }}>
            Opens {entry.displayName} in your browser to sign in — Eaon never sees your password, only a token {entry.displayName} issues afterward.
          </div>
        </>
      ) : (
        <>
          <div className="settings-row">
            <input
              className="settings-input settings-grow"
              type="password"
              placeholder={entry.tokenFieldPlaceholder}
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && tokenInput.trim()) void connectPastedToken(entry, tokenInput.trim());
              }}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={!tokenInput.trim()}
              onClick={() => void connectPastedToken(entry, tokenInput.trim())}
            >
              Connect
            </Button>
          </div>
          {entry.tokenHint && <div className="settings-note" style={{ margin: 0, fontSize: 11.5 }}>{entry.tokenHint}</div>}
          {entry.tokenCreationURL && (
            <button type="button" className="plugin-link" onClick={() => void openUrl(entry.tokenCreationURL!)}>
              Create a token <ExternalLink size={12} />
            </button>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Custom servers — any MCP server reachable by URL, not just the catalog
// ---------------------------------------------------------------------------

function CustomServersSection() {
  const servers = useSettings((s) => s.settings.mcpServers);
  const update = useSettings((s) => s.update);
  // Connection state lives in the store, not this component — leaving the
  // Plugins page and coming back must keep showing "Connected · N tools"
  // for a server that is, in fact, still connected.
  const states = useMcpConnections((s) => s.states);
  const connectCustom = useMcpConnections((s) => s.connectCustom);
  const disconnectCustom = useMcpConnections((s) => s.disconnectCustom);
  const [addOpen, setAddOpen] = useState(false);
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authScheme, setAuthScheme] = useState("Bearer");
  const [token, setToken] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");

  const patchServer = (id: string, patch: Partial<McpServer>) =>
    update({ mcpServers: servers.map((s) => (s.id === id ? { ...s, ...patch } : s)) });

  const remove = (id: string) => {
    void disconnectCustom(id);
    update({ mcpServers: servers.filter((s) => s.id !== id) });
  };

  const addServer = () => {
    const server: McpServer = {
      id: uid(),
      name: name.trim(),
      transport,
      url: url.trim(),
      authScheme: authScheme.trim() || "Bearer",
      token: token.trim(),
      command: command.trim(),
      args: args.trim(),
      enabled: true,
    };
    update({ mcpServers: [...servers, server] });
    setAddOpen(false);
    setName(""); setUrl(""); setToken(""); setCommand(""); setArgs("");
    setAuthScheme("Bearer"); setTransport("http");
  };

  const addValid =
    name.trim().length > 0 &&
    (transport === "http" ? url.trim().length > 0 : command.trim().length > 0);

  return (
    <>
      <div className="custom-servers-header">
        <span className="custom-servers-title">Custom servers</span>
        <button type="button" className="plugin-link" onClick={() => setAddOpen(true)}>
          <Plus size={13} /> Add
        </button>
      </div>
      {servers.length === 0 ? (
        <div className="settings-note" style={{ marginTop: 4 }}>
          Connect to any MCP server (Streamable HTTP or local stdio) by URL — not just the catalog above.
        </div>
      ) : (
        <div className="settings-card">
          {servers.map((server) => {
            const state: McpConnectionState = states[server.id] ?? { status: "disconnected" };
            return (
              <div key={server.id} className="item-row">
                <div className="item-main">
                  <div className="item-title">
                    {server.name}
                    <span className="tag-chip">{server.transport === "http" ? "Remote" : "Local"}</span>
                    {state.status === "connected" && (
                      <span className="settings-ok" style={{ marginTop: 0 }}>
                        {state.toolCount} {state.toolCount === 1 ? "tool" : "tools"}
                      </span>
                    )}
                  </div>
                  <div className="item-sub">
                    {server.transport === "http"
                      ? server.url
                      : `${server.command} ${server.args}`.trim()}
                  </div>
                  {state.status === "failed" && <div className="settings-error">{state.message}</div>}
                </div>
                <div className="item-actions">
                  <Switch
                    checked={server.enabled}
                    onChange={(enabled) => {
                      patchServer(server.id, { enabled });
                      if (!enabled && state.status === "connected") void disconnectCustom(server.id);
                    }}
                    aria-label={`Enable ${server.name}`}
                  />
                  {state.status === "connected" ? (
                    <Button size="sm" onClick={() => void disconnectCustom(server.id)}>
                      Disconnect
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      loading={state.status === "connecting"}
                      disabled={!server.enabled}
                      onClick={() => void connectCustom(server)}
                    >
                      Connect
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => remove(server.id)}>
                    Delete
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add plugin"
        footer={
          <Button variant="primary" size="sm" disabled={!addValid} onClick={addServer}>
            Add plugin
          </Button>
        }
      >
        <div className="tab-row">
          <button className={transport === "http" ? "active" : ""} onClick={() => setTransport("http")}>
            Remote
          </button>
          <button className={transport === "stdio" ? "active" : ""} onClick={() => setTransport("stdio")}>
            Local
          </button>
        </div>
        <div className="settings-row">
          <input
            className="settings-input"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {transport === "http" ? (
          <>
            <div className="settings-row">
              <input
                className="settings-input"
                placeholder="https://mcp.example.com/mcp"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="settings-row">
              <input
                className="settings-input"
                style={{ width: 120, flex: "none" }}
                placeholder="Bearer"
                aria-label="Authorization scheme"
                value={authScheme}
                onChange={(e) => setAuthScheme(e.target.value)}
              />
              <input
                className="settings-input settings-grow"
                type="password"
                placeholder="Access token (optional)"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
          </>
        ) : (
          <>
            <div className="settings-row">
              <input
                className="settings-input"
                placeholder="Command (e.g. npx)"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
              />
            </div>
            <div className="settings-row">
              <input
                className="settings-input"
                placeholder="Arguments (space-separated)"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
              />
            </div>
            <div className="settings-note">Local plugins run real programs on this PC.</div>
          </>
        )}
      </Dialog>
    </>
  );
}
