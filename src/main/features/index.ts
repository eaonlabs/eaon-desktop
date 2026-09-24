import { browserBridgeFeature } from './browserBridge'
import { computerUseFeature } from './computerUse'
import { eaonCodeFeature } from './eaonCode'
import { petsFeature } from './pets'
import { schedulerFeature } from './scheduler'
import { skillsFeature } from './skills'
import { modelLibraryFeature } from './modelLibrary'
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
  petsFeature
]
