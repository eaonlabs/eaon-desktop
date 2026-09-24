import { browserBridgeFeature } from './browserBridge'
import { computerUseFeature } from './computerUse'
import { eaonCodeFeature } from './eaonCode'
import { petsFeature } from './pets'
import { schedulerFeature } from './scheduler'
import { skillsFeature } from './skills'
import type { Feature } from './types'

/** Every feature module, registered in this order at startup. */
export const FEATURES: Feature[] = [
  skillsFeature,
  computerUseFeature,
  browserBridgeFeature,
  schedulerFeature,
  eaonCodeFeature,
  petsFeature
]
