import { useEffect, useState } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Select, Switch } from '../../ui'

type EmbeddingModel = { providerId: string; modelId: string; label: string; dimensions: number }

/**
 * Controls for the local codebase index that powers Eaon Work's
 * `codebase_search`. The important thing this page communicates is that the
 * index still works *without* an embedding model — it just drops to keyword
 * matching — because Anthropic-only users have no embeddings endpoint at all.
 */
export function CodeIndexPage(): JSX.Element {
  const { settings, patchSettings, workspaces, indexStatus, reindex } = useApp()
  const [models, setModels] = useState<EmbeddingModel[]>([])
  const [state, setState] = useState('')

  const cwd = workspaces.find((w) => w.kind === 'work')?.cwd ?? null

  useEffect(() => {
    void window.api.codeIndex.embeddingModels().then((result) => {
      setModels(result.models)
      setState(result.state)
    })
  }, [settings])

  if (!settings) return <></>
  const config = settings.codeIndex

  const selected = config.embeddingModelId ? `${config.embeddingProviderId}:${config.embeddingModelId}` : ''

  const options = [
    { value: '', label: 'None — keyword search only' },
    ...models.map((model) => ({ value: `${model.providerId}:${model.modelId}`, label: model.label }))
  ]

  const chooseModel = (value: string): void => {
    const [embeddingProviderId, embeddingModelId] = value ? value.split(':') : [null, null]
    void patchSettings({ codeIndex: { ...config, embeddingProviderId, embeddingModelId } })
  }

  const busy = indexStatus?.state === 'indexing'

  return (
    <>
      <h1 className="settings__h1">Code index</h1>
      <p className="settings__lede">
        Eaon Work indexes your project folder so it can search code by meaning, not just by keyword. The index is
        built and stored entirely on this machine.
      </p>

      <Section label="Status">
        <Card>
          <Row
            title="Project folder"
            description={cwd ?? 'No folder chosen yet — pick one from the Eaon Work composer.'}
          />
          <Row
            title="Index"
            description={
              busy
                ? (indexStatus?.phase ?? 'Working…')
                : indexStatus?.state === 'error'
                  ? (indexStatus.error ?? 'Indexing failed.')
                  : indexStatus?.state === 'ready'
                    ? `${indexStatus.files.toLocaleString()} files · ${indexStatus.chunks.toLocaleString()} chunks · ${
                        indexStatus.embedded ? 'semantic search' : 'keyword search'
                      }${indexStatus.truncated ? ' · truncated at the size limit' : ''}`
                    : 'Not built yet.'
            }
          >
            <button className="btn" disabled={!cwd || busy} onClick={() => void reindex(true)}>
              <RefreshCw size={14} strokeWidth={1.9} className={busy ? 'spinner' : undefined} />
              {busy ? 'Indexing…' : 'Rebuild'}
            </button>
            <button
              className="btn btn--ghost"
              disabled={!cwd || busy}
              onClick={() => {
                if (cwd) void window.api.codeIndex.clear(cwd)
              }}
            >
              <Trash2 size={14} strokeWidth={1.9} />
              Clear
            </button>
          </Row>
          <Row
            title="Index automatically"
            description="Refresh the index when a project folder is opened. Only changed files are re-processed."
          >
            <Switch
              label="Index automatically"
              checked={config.autoIndex}
              onChange={(autoIndex) => void patchSettings({ codeIndex: { ...config, autoIndex } })}
            />
          </Row>
        </Card>
      </Section>

      <Section label="Semantic search">
        <Card>
          <Row
            title="Embedding model"
            description="Used to turn code into vectors so search understands intent. Chunks of changed files are sent to this provider; nothing else leaves your machine."
          >
            <Select width={260} value={selected} onChange={chooseModel} options={options} />
          </Row>
        </Card>
        <div className="kv">{state}</div>
      </Section>

      <Section label="Agent">
        <Card>
          <Row
            title="Maximum tool steps"
            description="How many times the agent may search, read, edit or run commands within a single reply before it must stop."
          >
            <Select
              width={140}
              value={String(config.maxToolRounds)}
              onChange={(value) => void patchSettings({ codeIndex: { ...config, maxToolRounds: Number(value) } })}
              options={[
                { value: '10', label: '10' },
                { value: '25', label: '25' },
                { value: '40', label: '40' },
                { value: '80', label: '80' },
                { value: '150', label: '150' }
              ]}
            />
          </Row>
        </Card>
      </Section>
    </>
  )
}
