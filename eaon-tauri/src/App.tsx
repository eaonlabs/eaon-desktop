// The app shell: startup wiring (persistence → model refresh → update
// check), global keyboard shortcuts, and the three-pane layout. Views read
// the stores directly — no prop threading from here.

import { useEffect, useState } from "react";
import { initPersistence } from "./state/persist";
import { useConversations } from "./state/conversations";
import { useModels } from "./state/models";
import { useSettings } from "./state/settings";
import { useMcpConnections } from "./state/mcpConnections";
import { autostartLocalServer } from "./state/localServer";
import { useUi } from "./state/ui";
import { checkForUpdate } from "./core/update";
import TitleBar from "./ui/layout/TitleBar";
import Sidebar from "./ui/layout/Sidebar";
import ChatView from "./ui/chat/ChatView";
import ModelsPage from "./ui/models/ModelsPage";
import ProjectsPage from "./ui/projects/ProjectsPage";
import SearchPalette from "./ui/search/SearchPalette";
import SettingsModal from "./ui/settings/SettingsModal";
import Onboarding from "./ui/onboarding/Onboarding";
import ToolConfirmDialog from "./ui/chat/ToolConfirmDialog";
import AgentQuestionDialog from "./ui/chat/AgentQuestionDialog";
import Toast from "./ui/common/Toast";
import "./ui/layout/layout.css";

export default function App() {
  const [ready, setReady] = useState(false);
  const selection = useUi((s) => s.selection);
  const settingsOpen = useUi((s) => s.settingsOpen);

  useEffect(() => {
    let disposed = false;
    (async () => {
      await initPersistence();
      if (disposed) return;
      setReady(true);

      const { settings } = useSettings.getState();
      if (!settings.hasSeenOnboarding) useUi.getState().setOnboardingOpen(true);

      // Non-blocking startup refreshes — failures surface in their own UI.
      const hostedRefresh = useModels.getState().refreshHosted();
      const ollamaRefresh = useModels.getState().refreshOllama();
      void useMcpConnections.getState().reconnectAllAtLaunch();
      if (useSettings.getState().settings.autoUpdateEnabled) {
        void checkForUpdate();
      }
      // The Local API server left enabled comes back by itself — after the
      // model refreshes settle, so its upstream snapshot isn't empty.
      void Promise.allSettled([hostedRefresh, ollamaRefresh]).then(() => autostartLocalServer());
    })();
    return () => {
      disposed = true;
    };
  }, []);

  // Recheck for as long as the app stays open, matching the "…and
  // periodically" copy on the setting — reads the toggle fresh each tick so
  // flipping it off takes effect on the very next interval, not just launch.
  useEffect(() => {
    const sixHours = 6 * 60 * 60 * 1000;
    const id = setInterval(() => {
      if (useSettings.getState().settings.autoUpdateEnabled) void checkForUpdate();
    }, sixHours);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      if (e.ctrlKey && !e.shiftKey && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === "n") {
          e.preventDefault();
          useConversations.getState().newConversation();
          ui.setSelection({ kind: "chat" });
        } else if (key === "p") {
          e.preventDefault();
          ui.setSelection({ kind: "projects" });
        } else if (key === "k") {
          e.preventDefault();
          ui.setPaletteOpen(!ui.paletteOpen);
        } else if (key === "\\") {
          e.preventDefault();
          ui.toggleSidebar();
        }
      }
      if (e.key === "Escape") {
        if (ui.paletteOpen) ui.setPaletteOpen(false);
        else if (ui.settingsOpen) ui.closeSettings();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ready) return <div className="app-boot" />;

  return (
    <div className="app-frame">
      <TitleBar />
      <div className="app-shell">
        <Sidebar />
        <main className="app-main">
          {settingsOpen ? (
            <SettingsModal />
          ) : selection.kind === "models" ? (
            <ModelsPage />
          ) : selection.kind === "projects" || selection.kind === "project" ? (
            <ProjectsPage />
          ) : (
            <ChatView />
          )}
        </main>
      </div>
      <SearchPalette />
      <Onboarding />
      <ToolConfirmDialog />
      <AgentQuestionDialog />
      <Toast />
    </div>
  );
}
