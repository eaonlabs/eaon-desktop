// Wires the persisted slices (settings, conversations/projects/stats) to
// the debounced state.json writer. One subscription point instead of a
// save call sprinkled through every action.

import { flushSave, loadPersistedState, scheduleSave } from "../core/persistence";
import type { AppStateBlob } from "../core/types";
import { useConversations } from "./conversations";
import { useSettings } from "./settings";

export function buildSnapshot(): AppStateBlob {
  const { settings } = useSettings.getState();
  const { conversations, projects, currentId, statistics } = useConversations.getState();
  return { schemaVersion: 2, conversations, projects, currentId, settings, statistics };
}

/** Loads state.json into the stores, then starts persisting changes. */
export async function initPersistence(): Promise<void> {
  const blob = await loadPersistedState();
  useSettings.getState().hydrate(blob.settings);
  useConversations.getState().hydrate({
    conversations: blob.conversations,
    projects: blob.projects,
    currentId: blob.currentId,
    statistics: blob.statistics,
  });

  useSettings.subscribe(() => scheduleSave(buildSnapshot));
  useConversations.subscribe(() => scheduleSave(buildSnapshot));

  // Flush the debounce on close so the last keystrokes of state land.
  window.addEventListener("beforeunload", () => {
    void flushSave();
  });
}
