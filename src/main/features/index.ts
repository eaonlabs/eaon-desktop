import { browserBridgeFeature } from './browserBridge'
import { computerUseFeature } from './computerUse'
import { discordPresenceFeature } from './discordPresence'
import { eaonCodeFeature } from './eaonCode'
import { schedulerFeature } from './scheduler'
import { skillsFeature } from './skills'
import { modelLibraryFeature } from './modelLibrary'
import { libraryFeature } from './library'
import { terminalsFeature } from './terminals'
import { workersFeature } from './workers'
import { channelsFeature } from './channels'
import { agentBrowserFeature } from './agentBrowser'
import { emailFeature } from './email'
import { tradingFeature } from './trading'
import { pluginsFeature } from './plugins'
import { providerAuthFeature } from './providerAuth'
import type { Feature } from './types'

/** Every feature module, registered in this order at startup. */
export const FEATURES: Feature[] = [
  providerAuthFeature,
  pluginsFeature,
  modelLibraryFeature,
  skillsFeature,
  computerUseFeature,
  browserBridgeFeature,
  schedulerFeature,
  eaonCodeFeature,
  libraryFeature,
  terminalsFeature,
  workersFeature,
  // Built on the workers engine, so after it.
  channelsFeature,
  agentBrowserFeature,
  emailFeature,
  tradingFeature,
  discordPresenceFeature
]
