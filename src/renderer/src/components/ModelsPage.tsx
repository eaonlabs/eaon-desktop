import { useEffect, useState, type ReactNode } from 'react'
import { useApp } from '../state/store'
import { CollapsedNav } from './CollapsedNav'
import { Segmented } from './ui'
import { useLibrary } from './models/libraryStore'
import { DEVICE, OllamaBanner } from './models/parts'
import { LibraryView } from './models/LibraryView'
import { LibraryDetail } from './models/LibraryDetail'
import { InstalledView } from './models/InstalledView'
import { HubBrowser, HubDetail } from './models/HubBrowser'

/**
 * Local models. Three tabs: the curated Library (suggestions sized to this
 * machine, one-click Get through Ollama), what is Installed, and the original
 * Hugging Face browser for anything else. See .eaonbrain/local-model-hub.md.
 *
 * Which detail view is open lives in the store's `modelsRepo` — a Hugging
 * Face repo id, or `library:<id>` for a catalog model — so clicking Models in
 * the sidebar always returns to the list. Pull progress lives in the store's
 * `modelDownloads`, which is what lets the header Downloads panel show it.
 */

type Tab = 'library' | 'installed' | 'hub'

export function ModelsPage(): JSX.Element {
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const selected = useApp((s) => s.modelsRepo)
  const setSelected = useApp((s) => s.setModelsRepo)
  const load = useLibrary((s) => s.load)
  const refresh = useLibrary((s) => s.refresh)
  const loadError = useLibrary((s) => s.loadError)
  const state = useLibrary((s) => s.state)
  const [tab, setTab] = useState<Tab>('library')

  useEffect(() => {
    void load()
    // Ollama may have been started, or a model pulled, from outside the app.
    const onFocus = (): void => void refresh().catch(() => {})
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load, refresh])

  const back = (): void => setSelected(null)
  let body: ReactNode
  if (selected?.startsWith('library:')) {
    body = <LibraryDetail modelId={selected.slice('library:'.length)} onBack={back} />
  } else if (selected) {
    body = <HubDetail repoId={selected} onBack={back} />
  } else {
    const installedCount = state?.installed.length ?? 0
    body = (
      <>
        <div className="mlib-head">
          <h1 className="page__title">Models</h1>
          <OllamaStatusLine />
        </div>
        <p className="page__subtitle">Open models that run privately on this {DEVICE}, through Ollama.</p>
        <div className="mlib-tabs">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'library', label: 'Library' },
              { value: 'installed', label: installedCount ? `Installed · ${installedCount}` : 'Installed' },
              { value: 'hub', label: 'Browse Hugging Face' }
            ]}
          />
        </div>
        {tab !== 'hub' && <OllamaBanner />}
        {loadError && <div className="models-empty models-empty--error">{loadError}</div>}
        {tab === 'library' && <LibraryView />}
        {tab === 'installed' && <InstalledView />}
        {tab === 'hub' && <HubBrowser />}
      </>
    )
  }

  return (
    <div className="page">
      <div className="page__bar" data-collapsed={!sidebarOpen || undefined}>
        {!sidebarOpen && <CollapsedNav />}
      </div>
      <div className="page__scroll scroll">
        <div className="page__inner page__inner--wide mlib">{body}</div>
      </div>
    </div>
  )
}

function OllamaStatusLine(): JSX.Element | null {
  const ollama = useLibrary((s) => s.state?.ollama)
  if (!ollama) return null
  return (
    <span className="mlib-ollama" data-state={ollama.state}>
      <span className="mlib-ollama__dot" aria-hidden="true" />
      {ollama.state === 'running' ? `Ollama ${ollama.version}` : ollama.state === 'stopped' ? 'Ollama stopped' : 'Ollama not installed'}
    </span>
  )
}
