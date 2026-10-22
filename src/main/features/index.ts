import { browserUseFeature } from './browserUse'
import { inAppBrowserFeature } from './inAppBrowser'
import { computerUseFeature } from './computerUse'
import { discordPresenceFeature } from './discordPresence'
import { eaonCodeFeature } from './eaonCode'
import { schedulerFeature } from './scheduler'
import { skillsFeature } from './skills'
import { modelLibraryFeature } from './modelLibrary'
import { libraryFeature } from './library'
import { workspaceFilesFeature } from './workspaceFiles'
import { wallpaperFeature } from './wallpaper'
import { terminalsFeature } from './terminals'
import { adeFeature } from './ade'
import { prReviewFeature } from './prReview'
import { linearFeature } from './linear'
import { workersFeature } from './workers'
import { workerHostFeature } from './workerHost'
import { remoteFeature } from './remote'
import { rcFeature } from './rc'
import { controlFeature } from './control'
import { starRepoFeature } from './starRepo'
import { toknCliFeature } from './toknCli'
import { freeCreditsFeature } from './freeCredits'
import { cliAccountsFeature } from './cliAccounts'
import { channelsFeature } from './channels'
import { agentBrowserFeature } from './agentBrowser'
import { emailFeature } from './email'
import { tradingFeature } from './trading'
import { pluginsFeature } from './plugins'
import { providerAuthFeature } from './providerAuth'
import { voiceFeature } from './voice'
import { providerUsageFeature } from './providerUsage'
import { agentProvidersFeature } from './agentProviders'
import { gatewayFeature } from './gateway'
import { connectAppsFeature } from './connectApps'
import { linkAccountsFeature } from './linkAccounts'
import { usageFeature } from './usage'
import { paymentsFeature } from './payments'
import { enginesFeature } from './engines'
import { enterpriseFeature } from './enterprise'
import type { Feature } from './types'

/** Every feature module, registered in this order at startup. */
export const FEATURES: Feature[] = [
  // First, so the policy is read and logged before anything it governs starts.
  enterpriseFeature,
  providerAuthFeature,
  // Agent engines (Codex…) before workers, which run turns on them.
  enginesFeature,
  pluginsFeature,
  modelLibraryFeature,
  skillsFeature,
  computerUseFeature,
  browserUseFeature,
  inAppBrowserFeature,
  schedulerFeature,
  eaonCodeFeature,
  libraryFeature,
  workspaceFilesFeature,
  wallpaperFeature,
  terminalsFeature,
  adeFeature,
  // Make ADE sessions, so after it.
  prReviewFeature,
  linearFeature,
  workersFeature,
  // Decides where the workers run (here, or on a linked worker computer) before anything else uses them.
  workerHostFeature,
  // Follows the workers engine, so right after it.
  remoteFeature,
  // After workers, terminals and the ADE, whose parts it serves.
  rcFeature,
  // Drives the app for Eaon CLI; needs the workers service, so after it.
  controlFeature,
  // Built on the workers engine, so after it.
  channelsFeature,
  agentBrowserFeature,
  // Types card details into the agent's browser, so after it.
  paymentsFeature,
  emailFeature,
  tradingFeature,
  voiceFeature,
  providerUsageFeature,
  agentProvidersFeature,
  gatewayFeature,
  connectAppsFeature,
  linkAccountsFeature,
  usageFeature,
  starRepoFeature,
  toknCliFeature,
  freeCreditsFeature,
  cliAccountsFeature,
  discordPresenceFeature
]
