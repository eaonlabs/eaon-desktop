import { useMemo } from 'react'
import type { EffortLevel } from '@shared/types'
import { ENGINE_LABEL } from '@shared/engines'
import { engineModelKey, engineReadiness, type SetupAction } from '@shared/modelSelection'
import { useApp } from '../../state/store'
import { useEngineModels } from './ModelSelect'

/** Chat's model when it is an agent engine's (a Codex model) rather than a provider's. */
export interface ChatEngineChoice {
  engine: 'codex'
  /** The engine's model id; '' for its own default. */
  modelId: string
  label: string
  efforts: EffortLevel[]
  /** `engine:codex:<model>`, for marking the current row in a picker. */
  key: string
  /** The engine can run a turn now (installed, recent enough, signed in). */
  ready: boolean
  reason: string | null
  action: SetupAction | null
}

/** The engine model Chat is set to, with whether it can run now; null when Chat uses a provider's model. */
export function useChatEngine(): ChatEngineChoice | null {
  const engine = useApp((s) => s.settings?.selectedEngine ?? null)
  const modelId = useApp((s) => s.settings?.selectedEngineModel ?? '')
  // 'native' lists nothing, so the hook is always called (one engine at a time).
  const { status, models } = useEngineModels(engine ?? 'native')
  return useMemo(() => {
    if (!engine) return null
    const readiness = engineReadiness(engine, status)
    const list = models?.models ?? []
    const model = modelId ? list.find((m) => m.id === modelId) : list.find((m) => m.isDefault)
    const name = ENGINE_LABEL[engine]
    return {
      engine,
      modelId,
      label: `${name} · ${model?.label ?? (modelId || 'default')}`,
      efforts: model?.efforts ?? [],
      key: engineModelKey(engine, modelId),
      ready: readiness.state === 'ready',
      reason: readiness.reason,
      action: readiness.action
    }
  }, [engine, modelId, status, models])
}
