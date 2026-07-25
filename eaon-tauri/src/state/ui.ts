// Ephemeral UI state — never persisted (except the mode, which rides in the
// persist wiring's settings snapshot? No: mode is per-launch like the Mac
// app's current mode; kept here, defaulting to chat).

import { create } from "zustand";
import type { EaonMode, SidebarSelection } from "../core/types";

export type SettingsPage =
  | "general"
  | "appearance"
  | "shortcuts"
  | "instructions"
  | "params"
  | "memory"
  | "skills"
  /** A single provider's own page (Eaon API, or one BYOK connection) — which
   *  one is in settingsProviderId, since the sidebar lists one row per
   *  configured connection rather than one shared list page. */
  | "provider"
  | "local"
  | "plugins"
  | "images"
  | "server"
  | "network"
  | "eaoncli"
  | "privacy"
  | "statistics"
  | "hardware";

/** The sentinel settingsProviderId for the built-in hosted connection —
 *  never a real CustomProvider.id, which comes from uid(). */
export const EAON_PROVIDER_ID = "eaon";

/** The sentinel settingsProviderId for the Free Trial provider — matches
 *  the "freeTrial" ModelEntry.provider.kind discriminant exactly, so it
 *  doubles as the settings.disabledProviders entry with no translation. */
export const FREE_TRIAL_PROVIDER_ID = "freeTrial";

export interface UpdateInfo {
  latestVersion: string;
  releaseNotes: string | null;
  /** Platform-appropriate download destination (releases page). */
  url: string;
}

interface UiStore {
  sidebarOpen: boolean;
  selection: SidebarSelection;
  mode: EaonMode;
  paletteOpen: boolean;
  settingsOpen: boolean;
  settingsPage: SettingsPage;
  /** Which connection the "provider" page shows — EAON_PROVIDER_ID or a
   *  CustomProvider's id. Irrelevant for every other page. */
  settingsProviderId: string;
  onboardingOpen: boolean;
  update: UpdateInfo | null;
  /** One transient toast at a time ("Copied", errors). */
  toast: string | null;

  toggleSidebar: () => void;
  setSelection: (selection: SidebarSelection) => void;
  setMode: (mode: EaonMode) => void;
  setPaletteOpen: (open: boolean) => void;
  openSettings: (page?: SettingsPage, providerId?: string) => void;
  closeSettings: () => void;
  setOnboardingOpen: (open: boolean) => void;
  setUpdate: (update: UpdateInfo | null) => void;
  showToast: (message: string) => void;
}

let toastTimer: number | null = null;

export const useUi = create<UiStore>((set) => ({
  sidebarOpen: true,
  selection: { kind: "chat" },
  mode: "chat",
  paletteOpen: false,
  settingsOpen: false,
  settingsPage: "general",
  settingsProviderId: EAON_PROVIDER_ID,
  onboardingOpen: false,
  update: null,
  toast: null,

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  // Picking a chat/project/models destination always means "leave settings"
  // — App.tsx renders SettingsModal over the selection while settingsOpen is
  // true, so without this, sidebar/palette navigation silently no-ops while
  // in Settings.
  setSelection: (selection) => set({ selection, settingsOpen: false }),
  setMode: (mode) => set({ mode }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  openSettings: (page, providerId) =>
    set((s) => ({
      settingsOpen: true,
      settingsPage: page ?? s.settingsPage,
      settingsProviderId: providerId ?? s.settingsProviderId,
    })),
  closeSettings: () => set({ settingsOpen: false }),
  setOnboardingOpen: (onboardingOpen) => set({ onboardingOpen }),
  setUpdate: (update) => set({ update }),
  showToast: (message) => {
    if (toastTimer !== null) clearTimeout(toastTimer);
    set({ toast: message });
    toastTimer = window.setTimeout(() => set({ toast: null }), 2200);
  },
}));
