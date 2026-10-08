import { browserBridgeFeature } from './browserBridge'
import { computerUseFeature } from './computerUse'
import { discordPresenceFeature } from './discordPresence'
import { eaonCodeFeature } from './eaonCode'
import { schedulerFeature } from './scheduler'
import { skillsFeature } from './skills'
import { modelLibraryFeature } from './modelLibrary'
import { libraryFeature } from './library'
import { terminalsFeature } from './terminals'
import { adeFeature } from './ade'
import { prReviewFeature } from './prReview'
import { linearFeature } from './linear'
import { workersFeature } from './workers'
import { remoteFeature } from './remote'
import { controlFeature } from './control'
import { starRepoFeature } from './starRepo'
import { cliAccountsFeature } from './cliAccounts'
import { channelsFeature } from './channels'
import { agentBrowserFeature } from './agentBrowser'
import { emailFeature } from './email'
import { tradingFeature } from './trading'
import { pluginsFeature } from './plugins'
import { providerAuthFeature } from './providerAuth'
import { voiceFeature } from './voice'
import { gatewayFeature } from './gateway'
import { connectAppsFeature } from './connectApps'
import { linkAccountsFeature } from './linkAccounts'
import { usageFeature } from './usage'
import { paymentsFeature } from './payments'
import { enginesFeature } from './engines'
import type { Feature } from './types'

/** Every feature module, registered in this order at startup. */
export const FEATURES: Feature[] = [
  providerAuthFeature,
  // Agent engines (Codex…) before workers, which run turns on them.
  enginesFeature,
  pluginsFeature,
  modelLibraryFeature,
  skillsFeature,
  computerUseFeature,
  browserBridgeFeature,
  schedulerFeature,
  eaonCodeFeature,
  libraryFeature,
  terminalsFeature,
  adeFeature,
  // Make ADE sessions, so after it.
  prReviewFeature,
  linearFeature,
  workersFeature,
  // Follows the workers engine, so right after it.
  remoteFeature,
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
  gatewayFeature,
  connectAppsFeature,
  linkAccountsFeature,
  usageFeature,
  starRepoFeature,
  cliAccountsFeature,
  discordPresenceFeature
]
