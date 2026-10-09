/**
 * Timeouts for a machine that is not quiet.
 *
 * Every timeout in the suite is written for an idle laptop. When many
 * processes compete for the cores (another build, another agent running its
 * own tests) Electron takes ten times as long to start, quit and paint, and
 * the same scenarios fail on timing alone. The load average at the start of
 * the test process stretches every timeout, within reason: 1x up to about two
 * runnable processes per core, up to 4x beyond that.
 *
 * `EAON_E2E_TIMEOUT_SCALE=<n>` sets it by hand (CI uses the default, which
 * is 1 on a fresh runner).
 */
import { cpus, loadavg } from 'node:os'

function compute() {
  const forced = Number(process.env.EAON_E2E_TIMEOUT_SCALE)
  if (Number.isFinite(forced) && forced > 0) return forced
  const perCore = loadavg()[0] / Math.max(1, cpus().length)
  return Math.min(4, Math.max(1, Math.round(perCore / 2)))
}

export const timeoutScale = compute()

/** @param {number} ms */
export const scaled = (ms) => Math.round(ms * timeoutScale)
