import type { Feature } from './types'
import { createScheduler, type SchedulerService } from './scheduler/service'

/**
 * Scheduled tasks: prompts that run on a cadence in the background, each run
 * producing a chat. The engine (`scheduler/engine.ts`) decides when, the
 * runner (`scheduler/runner.ts`) runs the agent headlessly, and the service
 * (`scheduler/service.ts`) connects them to storage, the window and IPC.
 */

let service: SchedulerService | null = null

export const schedulerFeature: Feature = {
  id: 'scheduler',
  register: (ctx) => {
    service = createScheduler(ctx)
    // Load before the IPC exists, so the first `scheduler:ready` already sees the tasks.
    service.start()
    service.registerIpc()
  },
  dispose: () => service?.stop()
}
