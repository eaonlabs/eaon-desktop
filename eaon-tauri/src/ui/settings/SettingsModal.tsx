// The Settings view: a page — not a modal — that takes over the main content
// area (same slot as ChatView/ModelsPage/ProjectsPage) with a page nav on the
// left and one pane component per page on the right. All pane content lives
// in panes/ — this file only routes.
//
// MODEL PROVIDERS and LOCAL are dynamic, not part of the static SECTIONS
// list below: one row per configured connection (Eaon API always present,
// then each BYOK provider), each navigating to its own dedicated page —
// mirrors the Mac app rather than one shared "all providers" list.

import { useState } from "react";
import {
  BarChart3,
  Brain,
  Cpu,
  Droplet,
  FileText,
  Gift,
  Globe,
  HardDrive,
  Image as ImageIcon,
  Info,
  Keyboard,
  Palette,
  Plus,
  Puzzle,
  Server,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { EAON_PROVIDER_ID, FREE_TRIAL_PROVIDER_ID, useUi, type SettingsPage } from "../../state/ui";
import { useSettings } from "../../state/settings";
import BrandLogo from "../models/BrandLogo";
import AddProviderDialog from "./panes/AddProviderDialog";
import GeneralPane from "./panes/GeneralPane";
import AppearancePane from "./panes/AppearancePane";
import ShortcutsPane from "./panes/ShortcutsPane";
import InstructionsPane from "./panes/InstructionsPane";
import ParamsPane from "./panes/ParamsPane";
import MemoryPane from "./panes/MemoryPane";
import SkillsPane from "./panes/SkillsPane";
import ProvidersPane from "./panes/ProvidersPane";
import LocalPane from "./panes/LocalPane";
import PluginsPane from "./panes/PluginsPane";
import EaonCliPane from "./panes/EaonCliPane";
import ImagesPane from "./panes/ImagesPane";
import ServerPane from "./panes/ServerPane";
import NetworkPane from "./panes/NetworkPane";
import PrivacyPane from "./panes/PrivacyPane";
import StatisticsPane from "./panes/StatisticsPane";
import HardwarePane from "./panes/HardwarePane";
import "./settings.css";

interface NavItem {
  page: SettingsPage;
  label: string;
  icon: LucideIcon;
}

const SECTIONS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "General",
    items: [
      { page: "general", label: "General", icon: Info },
      { page: "appearance", label: "Appearance", icon: Palette },
      { page: "shortcuts", label: "Shortcuts", icon: Keyboard },
    ],
  },
  {
    label: "Assistant",
    items: [
      { page: "instructions", label: "Instructions", icon: FileText },
      { page: "params", label: "Model parameters", icon: SlidersHorizontal },
      { page: "memory", label: "Memory", icon: Brain },
      { page: "skills", label: "Skills", icon: Sparkles },
    ],
  },
  {
    label: "Tools",
    items: [
      { page: "plugins", label: "Plugins", icon: Puzzle },
      { page: "images", label: "Image generation", icon: ImageIcon },
      { page: "server", label: "Local API server", icon: Server },
      { page: "network", label: "Network", icon: Globe },
      { page: "eaoncli", label: "Eaon CLI", icon: Terminal },
    ],
  },
  {
    label: "System",
    items: [
      { page: "privacy", label: "Privacy & data", icon: Shield },
      { page: "statistics", label: "Statistics", icon: BarChart3 },
      { page: "hardware", label: "Hardware", icon: Cpu },
    ],
  },
];

const PANES: Record<SettingsPage, () => JSX.Element> = {
  general: GeneralPane,
  appearance: AppearancePane,
  shortcuts: ShortcutsPane,
  instructions: InstructionsPane,
  params: ParamsPane,
  memory: MemoryPane,
  skills: SkillsPane,
  provider: ProvidersPane,
  local: LocalPane,
  plugins: PluginsPane,
  images: ImagesPane,
  server: ServerPane,
  network: NetworkPane,
  eaoncli: EaonCliPane,
  privacy: PrivacyPane,
  statistics: StatisticsPane,
  hardware: HardwarePane,
};

export default function SettingsModal() {
  const page = useUi((s) => s.settingsPage);
  const providerId = useUi((s) => s.settingsProviderId);
  const openSettings = useUi((s) => s.openSettings);
  const customProviders = useSettings((s) => s.settings.customProviders);
  const [addOpen, setAddOpen] = useState(false);

  const Pane = PANES[page];

  return (
    <div className="settings-view">
      <nav className="settings-nav">
        <div className="settings-nav-title">Settings</div>
        {SECTIONS.map((section) => (
          <div key={section.label}>
            <div className="settings-nav-section">{section.label}</div>
            {section.items.map(({ page: p, label, icon: Icon }) => (
              <button
                key={p}
                className={p === page ? "settings-nav-row active" : "settings-nav-row"}
                onClick={() => openSettings(p)}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>
        ))}

        <div className="settings-nav-section-row">
          <span className="settings-nav-section">Model Providers</span>
          <button className="nav-add-btn" aria-label="Add provider" title="Add provider" onClick={() => setAddOpen(true)}>
            <Plus size={13} />
          </button>
        </div>
        <button
          className={
            page === "provider" && providerId === EAON_PROVIDER_ID
              ? "settings-nav-row active"
              : "settings-nav-row"
          }
          onClick={() => openSettings("provider", EAON_PROVIDER_ID)}
        >
          <span className="nav-provider-icon eaon-tinted">
            <Droplet size={13} fill="currentColor" />
          </span>
          Eaon API
        </button>
        <button
          className={
            page === "provider" && providerId === FREE_TRIAL_PROVIDER_ID
              ? "settings-nav-row active"
              : "settings-nav-row"
          }
          onClick={() => openSettings("provider", FREE_TRIAL_PROVIDER_ID)}
        >
          <span className="nav-provider-icon eaon-tinted">
            <Gift size={13} />
          </span>
          Free Trial
        </button>
        {customProviders.map((provider) => (
          <button
            key={provider.id}
            className={
              page === "provider" && providerId === provider.id ? "settings-nav-row active" : "settings-nav-row"
            }
            onClick={() => openSettings("provider", provider.id)}
          >
            <span className="nav-provider-icon">
              <BrandLogo name={provider.displayName} size={16} />
            </span>
            <span className="settings-grow" style={{ textAlign: "left" }}>
              {provider.displayName}
            </span>
            {provider.apiKey.trim().length > 0 && <span className="status-dot on" />}
          </button>
        ))}

        <div className="settings-nav-section">Local</div>
        <button
          className={page === "local" ? "settings-nav-row active" : "settings-nav-row"}
          onClick={() => openSettings("local")}
        >
          <HardDrive size={15} />
          Ollama
        </button>
      </nav>
      <div className="settings-pane-wrap">
        <div className="settings-pane">
          <Pane />
        </div>
      </div>

      <AddProviderDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
