import { useCallback, useEffect, useState } from 'react'
import type { VmDeviceState } from '@shared/vms'

/**
 * This computer and the worker computer, with their VMs, kept current: the
 * VMs as the main process reports them change, the devices' own details
 * (free space, what they can run) every so often.
 */
export function useVmDevices(): { devices: VmDeviceState[] | null; refresh: () => Promise<void> } {
  const [devices, setDevices] = useState<VmDeviceState[] | null>(null)

  const refresh = useCallback(async () => {
    const next = await window.api.vms.devices().catch(() => null)
    if (next) setDevices(next)
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 20_000)
    const off = window.api.vms.onChanged((device, vms) => {
      setDevices((current) => current?.map((state) => (state.device === device ? { ...state, vms } : state)) ?? current)
    })
    return () => {
      clearInterval(timer)
      off()
    }
  }, [refresh])

  return { devices, refresh }
}

/** Runs a VM action, turning a failure into a message for the page. */
export const cleanVmError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
