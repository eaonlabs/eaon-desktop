import type { Feature } from './types'
import { createWorkersService, type WorkersService } from './workers/service'

/**
 * Eaon Workers: always-on agents with one endless thread each, that wake on
 * mail from the user or each other and on heartbeats they schedule
 * themselves. The engine (`workers/engine.ts`) decides when a worker runs, the
 * runner (`workers/runner.ts`) runs one turn headlessly, `workers/tools.ts`
 * is how workers reach each other, and the service connects it all to
 * storage, the window and IPC. Main owns workers, so they keep working with
 * no window open.
 */

let service: WorkersService | null = null

/** The running service, for features built on workers (chat apps). Null before registration. */
export function workersService(): WorkersService | null {
  return service
}

export const workersFeature: Feature = {
  id: 'workers',
  register: (ctx) => {
    service = createWorkersService(ctx)
    // Load before the IPC exists, so the renderer's first `workers:list` sees them.
    service.start()
    service.registerIpc()
  },
  dispose: () => service?.stop()
}
