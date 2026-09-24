import type { Feature } from './types'

/** Scheduled tasks: prompts that run on a cadence in the background. (Registration seam.) */
export const schedulerFeature: Feature = {
  id: 'scheduler',
  register: () => {}
}
