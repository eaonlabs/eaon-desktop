// The shared Free Week row (General's Gifts card + the Free Trial provider
// page). Shows the live trial state, mints a credential on request, and
// surfaces the public gift counter. Server refusals are shown verbatim and
// calmly — never fake an active trial (mirrors FreeWeekTrial.swift's grace
// rules). Independent of whether an Eaon API key is set — Free Trial is its
// own provider now, not a fallback that disappears once you have a key.

import { useEffect, useState } from "react";
import { Gift } from "lucide-react";
import Button from "../../common/Button";
import { trialGift, trialStart, type TrialGiftStatus } from "../../../core/ipc";
import { useSettings } from "../../../state/settings";
import { useModels } from "../../../state/models";
import { FREE_TRIAL_PROVIDER_ID, useUi } from "../../../state/ui";

/** Server timestamps arrive in unix seconds; state stores milliseconds.
 *  Anything below 10^12 can only be seconds — normalize on read AND write
 *  so a credential stored by an older build still renders correctly. */
function toMs(value: number): number {
  return value < 1e12 ? value * 1000 : value;
}

/** A self-contained "Gifts" card — used as-is on both General and the Free
 *  Trial provider page. */
export default function TrialCard() {
  const trial = useSettings((s) => s.settings.trialCredential);
  const trialEnabled = useSettings((s) => !s.settings.disabledProviders.includes(FREE_TRIAL_PROVIDER_ID));
  const update = useSettings((s) => s.update);
  const showToast = useUi((s) => s.showToast);
  const [gift, setGift] = useState<TrialGiftStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    trialGift()
      .then((g) => {
        if (!cancelled) setGift(g);
      })
      .catch(() => {
        /* The gift counter is decoration — a failed fetch shows nothing. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const expiresMs = trial ? toMs(trial.expiresAt) : 0;
  const active = trial !== null && expiresMs > Date.now();
  const daysLeft = Math.max(1, Math.ceil((expiresMs - Date.now()) / 86_400_000));

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const result = await trialStart();
      update({
        trialCredential: {
          key: result.key,
          secret: result.secret,
          expiresAt: toMs(result.expiresAt),
        },
      });
      void useModels.getState().refreshHosted();
      showToast("Free Week started — enjoy");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const title = active ? `Free Week active — ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left` : "Free Week";
  const desc = !trialEnabled
    ? "Free Trial is turned off. Turning it back on won't add any time back — the clock keeps running either way."
    : active
      ? "Every hosted model is unlocked on this PC until then."
      : "7 days of every hosted model. No account, no card.";

  const body = (
    <>
      <div className="settings-detail-row">
        <div className="row-text">
          <div className="row-title">
            <Gift size={13} style={{ marginRight: 6, verticalAlign: -2 }} aria-hidden />
            {title}
          </div>
          <div className="row-desc">{desc}</div>
          {error && <div className="settings-error">{error}</div>}
        </div>
        {!trialEnabled ? (
          <span className="settings-badge">Turned off</span>
        ) : active ? null : (
          <Button variant="primary" size="sm" loading={starting} onClick={() => void start()}>
            Start Free Week
          </Button>
        )}
      </div>
      {gift && gift.available && trialEnabled && (
        <div className="settings-note">
          {gift.remaining} of {gift.total} left
          {gift.expiresAt !== null &&
            ` — offer ends ${new Date(toMs(gift.expiresAt)).toLocaleDateString()}`}
        </div>
      )}
    </>
  );

  return (
    <div className="settings-card">
      <div className="settings-card-heading">Gifts</div>
      {body}
    </div>
  );
}
