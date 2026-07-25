// First-run onboarding: welcome → the three ways to work → pick a starting
// path (Free Week trial, local models, or your own key). Skippable at every
// step; finishing or skipping marks hasSeenOnboarding.

import { useEffect, useState } from "react";
import {
  Bot, ChevronRight, HardDriveDownload, KeyRound, Loader2, MessageSquare, Sparkles,
} from "lucide-react";
import { trialStart } from "../../core/ipc";
import { useModels } from "../../state/models";
import { useSettings } from "../../state/settings";
import { EAON_PROVIDER_ID, useUi } from "../../state/ui";
import Button from "../common/Button";
import { BrandMark } from "../layout/TitleBar";
import "./onboarding.css";

const MODES = [
  {
    icon: MessageSquare,
    name: "Chat",
    desc: "Talk with state-of-the-art models — with web search, images, and memory built in.",
  },
  {
    icon: Bot,
    name: "Agent",
    desc: "Let Eaon read files, run commands, and finish multi-step tasks, each step with your approval.",
  },
  {
    icon: HardDriveDownload,
    name: "Local models",
    desc: "Download open models and chat entirely offline. Nothing leaves this computer.",
  },
];

export default function Onboarding() {
  const open = useUi((s) => s.onboardingOpen);
  const setOnboardingOpen = useUi((s) => s.setOnboardingOpen);
  const showToast = useUi((s) => s.showToast);
  const setSelection = useUi((s) => s.setSelection);
  const openSettings = useUi((s) => s.openSettings);
  const update = useSettings((s) => s.update);
  const [step, setStep] = useState(0);
  const [trialBusy, setTrialBusy] = useState(false);
  const [trialError, setTrialError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStep(0);
      setTrialError(null);
    }
  }, [open]);

  if (!open) return null;

  const finish = () => {
    update({ hasSeenOnboarding: true });
    setOnboardingOpen(false);
  };

  const startTrial = async () => {
    if (trialBusy) return;
    setTrialBusy(true);
    setTrialError(null);
    try {
      const result = await trialStart();
      // The server reports unix seconds; the app stores ms. Guard against a
      // future server already sending ms (anything past ~2001 in ms terms).
      const expiresAt = result.expiresAt > 1e12 ? result.expiresAt : result.expiresAt * 1000;
      update({ trialCredential: { key: result.key, secret: result.secret, expiresAt } });
      showToast("Free Week started");
      void useModels.getState().refreshHosted();
      finish();
    } catch (e) {
      setTrialError(String(e));
    } finally {
      setTrialBusy(false);
    }
  };

  return (
    <div className="onboarding">
      <Button variant="ghost" size="sm" className="onboarding-skip" onClick={finish}>
        Skip
      </Button>

      <div className="onboarding-col" key={step}>
        {step === 0 && (
          <>
            <BrandMark size={64} />
            <h1>Welcome to Eaon</h1>
            <p className="ob-sub">Hosted models, your own keys, or fully local — one app.</p>
            <Button variant="primary" className="ob-continue" onClick={() => setStep(1)}>
              Continue
            </Button>
          </>
        )}

        {step === 1 && (
          <>
            <h1>Three ways to work</h1>
            <div className="ob-modes">
              {MODES.map((mode) => (
                <div key={mode.name} className="ob-mode">
                  <mode.icon size={18} className="ob-mode-icon" />
                  <div>
                    <div className="ob-mode-name">{mode.name}</div>
                    <div className="ob-mode-desc">{mode.desc}</div>
                  </div>
                </div>
              ))}
            </div>
            <Button variant="primary" className="ob-continue" onClick={() => setStep(2)}>
              Continue
            </Button>
          </>
        )}

        {step === 2 && (
          <>
            <h1>Get started</h1>
            <div className="ob-cards">
              <button className="ob-card" onClick={() => void startTrial()} disabled={trialBusy}>
                {trialBusy ? (
                  <Loader2 size={18} className="ob-card-icon ob-card-spin" />
                ) : (
                  <Sparkles size={18} className="ob-card-icon" />
                )}
                <span className="ob-card-text">
                  <span className="ob-card-name">Start Free Week</span>
                  <span className="ob-card-desc">
                    Seven days of Eaon's hosted models on this device — no account needed.
                  </span>
                  {trialError && <span className="ob-error">{trialError}</span>}
                </span>
                <ChevronRight size={15} className="ob-card-chevron" />
              </button>
              <button
                className="ob-card"
                onClick={() => {
                  setSelection({ kind: "models" });
                  finish();
                }}
              >
                <HardDriveDownload size={18} className="ob-card-icon" />
                <span className="ob-card-text">
                  <span className="ob-card-name">Browse local models</span>
                  <span className="ob-card-desc">Download open models and run everything offline.</span>
                </span>
                <ChevronRight size={15} className="ob-card-chevron" />
              </button>
              <button
                className="ob-card"
                onClick={() => {
                  openSettings("provider", EAON_PROVIDER_ID);
                  finish();
                }}
              >
                <KeyRound size={18} className="ob-card-icon" />
                <span className="ob-card-text">
                  <span className="ob-card-name">Add your own key</span>
                  <span className="ob-card-desc">
                    Connect any OpenAI, Anthropic, or Gemini-compatible API.
                  </span>
                </span>
                <ChevronRight size={15} className="ob-card-chevron" />
              </button>
            </div>
          </>
        )}

        <div className="ob-dots">
          {[0, 1, 2].map((i) => (
            <button
              key={i}
              className={i === step ? "ob-dot on" : "ob-dot"}
              aria-label={`Step ${i + 1}`}
              onClick={() => setStep(i)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
