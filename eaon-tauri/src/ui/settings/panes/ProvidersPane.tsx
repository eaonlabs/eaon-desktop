// Routes the "provider" settings page to the right connection — Eaon API,
// Free Trial, or a specific BYOK connection's page — based on which row is
// selected in the sidebar's MODEL PROVIDERS section. A deleted or otherwise-
// missing connection falls back to Eaon API rather than blanking.

import { useEffect } from "react";
import { EAON_PROVIDER_ID, FREE_TRIAL_PROVIDER_ID } from "../../../state/ui";
import { useSettings } from "../../../state/settings";
import { useUi } from "../../../state/ui";
import EaonProviderPage from "./EaonProviderPage";
import FreeTrialProviderPage from "./FreeTrialProviderPage";
import CustomProviderPage from "./CustomProviderPage";

export default function ProvidersPane() {
  const providerId = useUi((s) => s.settingsProviderId);
  const openSettings = useUi((s) => s.openSettings);
  const customProviders = useSettings((s) => s.settings.customProviders);
  const provider = customProviders.find((p) => p.id === providerId);

  const missing =
    providerId !== EAON_PROVIDER_ID && providerId !== FREE_TRIAL_PROVIDER_ID && !provider;
  useEffect(() => {
    if (missing) openSettings("provider", EAON_PROVIDER_ID);
  }, [missing, openSettings]);

  if (providerId === EAON_PROVIDER_ID || missing) return <EaonProviderPage />;
  if (providerId === FREE_TRIAL_PROVIDER_ID) return <FreeTrialProviderPage />;
  return <CustomProviderPage provider={provider!} />;
}
