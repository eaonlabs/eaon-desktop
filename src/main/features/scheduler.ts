import { getLocalServerStatus } from '../localServer'
import type { Feature } from './types'
import { createScheduler, type SchedulerService } from './scheduler/service'

/**
 * Scheduled tasks: prompts that run on a cadence in the background, each run
 * producing a chat. The engine (`scheduler/engine.ts`) decides when, the
 * runner (`scheduler/runner.ts`) runs the agent headlessly, and the service
 * (`scheduler/service.ts`) connects them to storage, the window and IPC.
 */

let service: SchedulerService | null = null

/** The running scheduler, for features that start automations (email, webhooks). Null before registration. */
export function schedulerService(): SchedulerService | null {
  return service
}

export const schedulerFeature: Feature = {
  id: 'scheduler',
  register: (ctx) => {
    service = createScheduler(ctx, {
      // Where a webhook's address points: the Local API Server, wherever it listens now.
      hookBase: () => {
        const status = getLocalServerStatus()
        return { url: status.url ?? `http://127.0.0.1:${status.port}`, running: status.running }
      }
    })
    // Load before the IPC exists, so the first `scheduler:ready` already sees the tasks.
    service.start()
    service.registerIpc()
  },
  dispose: () => service?.stop()
}
