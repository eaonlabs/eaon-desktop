// Runtime state for MCP plugin connections — the cross-platform port of the
// Mac app's MCPConnectionStore, covering BOTH the built-in catalog and the
// user's custom servers (one state map, distinct id spaces: catalog ids are
// slugs, custom ids come from uid()). Credentials persist through Settings
// (state.json, same as everything else this app remembers); this store only
// ever holds the LIVE, in-memory connection status, cleared on relaunch same
// as the Rust-side connection registry it drives (mcp.rs's CONNECTIONS map
// lives for the process's lifetime too).

import { create } from "zustand";
import { mcpCatalogEntry, type McpCatalogEntry } from "../core/mcpCatalog";
import { mcpConnect, mcpDisconnect, mcpOAuthConnect } from "../core/ipc";
import { clearConnectedMcpTools, setConnectedMcpTools } from "../chat/send";
import { useSettings } from "./settings";
import type { BuiltinMcpConnection, McpServer } from "../core/types";

export type McpConnectionState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected"; toolCount: number }
  /** Discovery succeeded but this server doesn't support Dynamic Client
   *  Registration — a real fork in the flow, not a failure: the UI offers a
   *  client-id field rather than just reporting an error. */
  | { status: "needsManualClientId" }
  | { status: "failed"; message: string };

interface McpConnectionsStore {
  states: Record<string, McpConnectionState>;
  stateFor: (id: string) => McpConnectionState;
  /** Connects with a freshly-pasted token, persisting it only once the
   *  handshake actually succeeds — a bad paste is never remembered as if it
   *  worked. */
  connectPastedToken: (entry: McpCatalogEntry, token: string) => Promise<void>;
  /** Signs in via the MCP spec's OAuth flow. `interactive: true` opens the
   *  system browser; `interactive: false` (launch-time) only attempts a
   *  silent refresh and leaves the row disconnected otherwise. */
  connectOAuth: (entry: McpCatalogEntry, interactive: boolean, manualClientId?: string) => Promise<void>;
  disconnect: (entry: McpCatalogEntry) => Promise<void>;
  /** Connect one of the user's custom servers (Settings.mcpServers) — HTTP
   *  or local stdio. State lands in the same map so the Plugins page shows
   *  the truth even after navigating away and back. */
  connectCustom: (server: McpServer) => Promise<void>;
  disconnectCustom: (serverId: string) => Promise<void>;
  /** Called once at app launch: every catalog entry with stored credentials
   *  AND every enabled custom server reconnects, sequentially. No dialogs or
   *  toasts — an expired OAuth session quietly returns to "Sign in", and
   *  other failures land as the row's own status, same as a manual
   *  connect would. */
  reconnectAllAtLaunch: () => Promise<void>;
}

function patchStoredConnection(id: string, patch: Partial<BuiltinMcpConnection>): void {
  const { settings, update } = useSettings.getState();
  const existing = settings.builtinMcpConnections.find((c) => c.id === id);
  const next: BuiltinMcpConnection = existing ? { ...existing, ...patch } : { id, ...patch };
  update({
    builtinMcpConnections: existing
      ? settings.builtinMcpConnections.map((c) => (c.id === id ? next : c))
      : [...settings.builtinMcpConnections, next],
  });
}

function removeStoredConnection(id: string): void {
  const { settings, update } = useSettings.getState();
  update({ builtinMcpConnections: settings.builtinMcpConnections.filter((c) => c.id !== id) });
}

/** A stable, shared reference — a fresh `{ status: "disconnected" }`
 *  literal per call would give useSyncExternalStore a "changed" snapshot
 *  on every render for any id with no entry yet, which is an infinite
 *  render loop, not just a wasted allocation. */
const DISCONNECTED: McpConnectionState = { status: "disconnected" };

export const useMcpConnections = create<McpConnectionsStore>((set, get) => ({
  states: {},

  stateFor: (id) => get().states[id] ?? DISCONNECTED,

  connectPastedToken: async (entry, token) => {
    const trimmed = token.trim();
    if (!trimmed) return;
    set((s) => ({ states: { ...s.states, [entry.id]: { status: "connecting" } } }));
    try {
      const tools = await mcpConnect({
        serverId: entry.id,
        transport: "http",
        url: entry.endpoint,
        authScheme: entry.authScheme,
        token: trimmed,
        extraHeaders: entry.extraHeaders,
      });
      setConnectedMcpTools(entry.id, entry.displayName, tools);
      set((s) => ({ states: { ...s.states, [entry.id]: { status: "connected", toolCount: tools.length } } }));
      patchStoredConnection(entry.id, { token: trimmed });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set((s) => ({ states: { ...s.states, [entry.id]: { status: "failed", message } } }));
    }
  },

  connectOAuth: async (entry, interactive, manualClientId) => {
    set((s) => ({ states: { ...s.states, [entry.id]: { status: "connecting" } } }));
    const stored = useSettings.getState().settings.builtinMcpConnections.find((c) => c.id === entry.id);
    try {
      const result = await mcpOAuthConnect({
        serverId: entry.id,
        endpoint: entry.endpoint,
        interactive,
        clientId: stored?.clientId ?? null,
        clientSecret: stored?.clientSecret ?? null,
        accessToken: stored?.accessToken ?? null,
        refreshToken: stored?.refreshToken ?? null,
        expiresAt: stored?.expiresAt ?? null,
        manualClientId: manualClientId ?? null,
        extraHeaders: entry.extraHeaders,
      });
      if (result.kind === "connected") {
        setConnectedMcpTools(entry.id, entry.displayName, result.tools);
        set((s) => ({ states: { ...s.states, [entry.id]: { status: "connected", toolCount: result.tools.length } } }));
        patchStoredConnection(entry.id, {
          clientId: result.credentials.clientId,
          clientSecret: result.credentials.clientSecret ?? undefined,
          accessToken: result.tokens.accessToken,
          refreshToken: result.tokens.refreshToken ?? undefined,
          expiresAt: result.tokens.expiresAt ?? undefined,
        });
      } else if (result.kind === "needsManualClientId") {
        set((s) => ({ states: { ...s.states, [entry.id]: { status: "needsManualClientId" } } }));
      } else {
        // Silent (launch-time) miss — leave the row disconnected, no error.
        set((s) => ({ states: { ...s.states, [entry.id]: { status: "disconnected" } } }));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set((s) => ({ states: { ...s.states, [entry.id]: { status: "failed", message } } }));
    }
  },

  disconnect: async (entry) => {
    try {
      await mcpDisconnect(entry.id);
    } finally {
      clearConnectedMcpTools(entry.id);
      removeStoredConnection(entry.id);
      set((s) => ({ states: { ...s.states, [entry.id]: { status: "disconnected" } } }));
    }
  },

  connectCustom: async (server) => {
    set((s) => ({ states: { ...s.states, [server.id]: { status: "connecting" } } }));
    try {
      const tools = await mcpConnect({
        serverId: server.id,
        transport: server.transport,
        url: server.url,
        authScheme: server.authScheme,
        token: server.token,
        command: server.command,
        args: server.args.trim() ? server.args.trim().split(/\s+/) : [],
      });
      setConnectedMcpTools(server.id, server.name, tools);
      set((s) => ({ states: { ...s.states, [server.id]: { status: "connected", toolCount: tools.length } } }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set((s) => ({ states: { ...s.states, [server.id]: { status: "failed", message } } }));
    }
  },

  disconnectCustom: async (serverId) => {
    try {
      await mcpDisconnect(serverId);
    } finally {
      clearConnectedMcpTools(serverId);
      set((s) => ({ states: { ...s.states, [serverId]: { status: "disconnected" } } }));
    }
  },

  reconnectAllAtLaunch: async () => {
    const { settings } = useSettings.getState();
    // Exactly the entries the loops below will attempt — pre-marking them
    // as "connecting" up front means the Plugins page never shows a bare
    // "Connect" for a row whose turn in this sequential loop simply hasn't
    // come up yet, and nothing pre-marked can be skipped into a stuck
    // spinner. (Failures land on the row itself — failed state, no toast —
    // exactly as they always have for a manual connect.)
    const builtinTargets = settings.builtinMcpConnections.filter((c) => {
      const entry = mcpCatalogEntry(c.id);
      if (!entry) return false;
      return entry.authMode === "pastedToken" ? !!c.token : !!(c.accessToken || c.refreshToken);
    });
    const customTargets = settings.mcpServers.filter(
      (s) => s.enabled && (s.transport === "http" ? s.url.trim() : s.command.trim()),
    );
    set((s) => {
      const states = { ...s.states };
      for (const c of builtinTargets) states[c.id] = { status: "connecting" };
      for (const c of customTargets) states[c.id] = { status: "connecting" };
      return { states };
    });
    for (const stored of builtinTargets) {
      const entry = mcpCatalogEntry(stored.id);
      if (!entry) continue;
      if (entry.authMode === "pastedToken") {
        await get().connectPastedToken(entry, stored.token ?? "");
      } else {
        await get().connectOAuth(entry, false);
      }
    }
    for (const server of customTargets) {
      await get().connectCustom(server);
    }
  },
}));

/** Every catalog entry that has any stored credential, for the Plugins page
 *  to render as already-connecting on launch instead of a bare disconnected
 *  row for the brief window before reconnectAllAtLaunch's round-trip resolves. */
export function hasStoredCredential(id: string): boolean {
  const stored = useSettings.getState().settings.builtinMcpConnections.find((c) => c.id === id);
  return !!(stored?.token || stored?.accessToken || stored?.refreshToken);
}
