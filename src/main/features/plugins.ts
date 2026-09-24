import type { Feature } from './types'

/** Registration seam for the plugins feature's IPC. */
export const pluginsFeature: Feature = {
  id: 'plugins',
  register: () => {}
}
