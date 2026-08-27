import { useEffect, useState } from 'react'
import { Card, Row, Section } from '../../ui'
import type { SystemInfo } from '@shared/types'

const GB = 1024 ** 3

function formatGb(bytes: number): string {
  return `${(bytes / GB).toFixed(2)} GB`
}

/** A usage bar plus its percentage, matching the CPU/Memory rows in the design. */
function UsageBar({ percent }: { percent: number }): JSX.Element {
  return (
    <span className="usage">
      <span className="usage__track">
        <span className="usage__fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </span>
      <span className="usage__value">{percent.toFixed(2)}%</span>
    </span>
  )
}

export function SystemMonitorPage(): JSX.Element {
  const [info, setInfo] = useState<SystemInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      const next = await window.api.system.info()
      if (!cancelled) setInfo(next)
    }
    void poll()
    // CPU usage is a delta between samples, so it needs a steady cadence to
    // read meaningfully; 2s is responsive without being noisy.
    const timer = setInterval(() => void poll(), 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  if (!info) {
    return (
      <>
        <h1 className="settings__h1">System Monitor</h1>
        <p className="settings__lede">Reading hardware stats…</p>
      </>
    )
  }

  return (
    <>
      <h1 className="settings__h1">System Monitor</h1>

      <Section>
        <Card>
          <div className="row">
            <div className="row__body">
              <div className="provider-detail__section-title" style={{ marginBottom: 0 }}>
                Operating System
              </div>
            </div>
          </div>
          <Row title="Name">
            <span className="stat-value">{info.os.name}</span>
          </Row>
          <Row title="Version">
            <span className="stat-value">{info.os.version}</span>
          </Row>
        </Card>
      </Section>

      <Section>
        <Card>
          <div className="row">
            <div className="row__body">
              <div className="provider-detail__section-title" style={{ marginBottom: 0 }}>
                CPU
              </div>
            </div>
          </div>
          <Row title="Model">
            <span className="stat-value">{info.cpu.model}</span>
          </Row>
          <Row title="Architecture">
            <span className="stat-value">{info.cpu.architecture}</span>
          </Row>
          <Row title="Cores">
            <span className="stat-value">{info.cpu.cores}</span>
          </Row>
          <Row title="Usage">
            <UsageBar percent={info.cpu.usagePercent} />
          </Row>
        </Card>
      </Section>

      <Section>
        <Card>
          <div className="row">
            <div className="row__body">
              <div className="provider-detail__section-title" style={{ marginBottom: 0 }}>
                Memory
              </div>
            </div>
          </div>
          <Row title="Total RAM">
            <span className="stat-value">{formatGb(info.memory.totalBytes)}</span>
          </Row>
          <Row title="Available RAM">
            <span className="stat-value">{formatGb(info.memory.availableBytes)}</span>
          </Row>
          <Row title="Usage">
            <UsageBar percent={info.memory.usagePercent} />
          </Row>
        </Card>
      </Section>
    </>
  )
}
