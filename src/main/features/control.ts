import { setControlTools } from '../control/server'
import { createControlTools } from '../control/tools'
import type { Feature } from './types'

/**
 * Eaon's control API (control/): the tools Eaon CLI uses to drive the app.
 * They are served by the Local API Server; this connects the ones that act
 * on the window — switching tabs, opening an ADE folder or terminal,
 * changing a setting — to the renderer on `control:action`.
 */
export const controlFeature: Feature = {
  id: 'control',
  register: ({ getWindow, send }) => {
    setControlTools(
      createControlTools({
        act: (action) => {
          if (!getWindow()) throw new Error('Eaon has no window open. Open Eaon and try again.')
          send('control:action', action)
        },
        send: (channel, payload) => send(channel, payload)
      })
    )
  },
  dispose: () => setControlTools([])
}
