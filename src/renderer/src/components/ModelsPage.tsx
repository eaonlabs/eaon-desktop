import { useEffect, useState, type ReactNode } from 'react'
import { useApp } from '../state/store'
import { TopBar } from './TopBar'
import { Segmented } from './ui'
import { notify } from './Notice'
import { errorText } from '../lib/errors'
import { useLibrary } from './models/libraryStore'
import { DEVICE, RuntimeBanner } from './models/parts'
import { LibraryView } from './models/LibraryView'
import { LibraryDetail } from './models/LibraryDetail'
import { InstalledView } from './models/InstalledView'
import { HubBrowser, HubDetail } from './models/HubBrowser'

/**
 * Local models, run by Eaon's own llama.cpp. Three tabs: the curated Library
 * (suggestions sized to this machine, one-click Get), what is downloaded, and
 * the Hugging Face browser for anything else. See .eaonbrain/local-model-hub.md.
 *
 * Which detail view is open lives in the store's `modelsRepo` — a Hugging
 * Face repo id, or `library:<id>` for a catalog model — so clicking Models in
 * the sidebar always returns to the list. Pull progress lives in the store's
 * `modelDownloads`, which is what lets the header Downloads panel show it.
 */

type Tab = 'library' | 'installed' | 'hub'

export function ModelsPage(): JSX.Element {
  const selected = useApp((s) => s.modelsRepo)
  const setSelected = useApp((s) => s.setModelsRepo)
  const load = useLibrary((s) => s.load)
  const refresh = useLibrary((s) => s.refresh)
  const loadError = useLibrary((s) => s.loadError)
  const state = useLibrary((s) => s.state)
  const [tab, setTab] = useState<Tab>('library')

  useEffect(() => {
    void load()
    // A model may have finished loading or unloaded while the window was away.
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
          <RuntimeStatusLine />
        </div>
        <p className="page__subtitle">Open models that run privately on this {DEVICE}, with Eaon&rsquo;s built-in llama.cpp.</p>
        <div className="mlib-tabs">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'library', label: 'Library' },
              { value: 'installed', label: installedCount ? `Downloaded · ${installedCount}` : 'Downloaded' },
              { value: 'hub', label: 'Browse Hugging Face' }
            ]}
          />
        </div>
        {tab !== 'hub' && <RuntimeBanner />}
        {loadError && <div className="models-empty models-empty--error">{loadError}</div>}
        {tab === 'library' && <LibraryView />}
        {tab === 'installed' && <InstalledView />}
        {tab === 'hub' && <HubBrowser />}
      </>
    )
  }

  return (
    <div className="page">
      <TopBar variant="page__bar" />
      <div className="page__scroll scroll">
        <div className="page__inner page__inner--wide mlib">{body}</div>
      </div>
    </div>
  )
}

/** Which llama.cpp this build runs, and the model it has loaded right now (with a way to free the memory). */
function RuntimeStatusLine(): JSX.Element | null {
  const runtime = useLibrary((s) => s.state?.runtime)
  const unload = useLibrary((s) => s.unload)
  if (!runtime) return null
  const build = runtime.version ? /build (\d+)/.exec(runtime.version)?.[1] : null
  return (
    <span className="mlib-ollama" data-state={runtime.available ? 'running' : 'missing'} title={runtime.version ?? undefined}>
      <span className="mlib-ollama__dot" aria-hidden="true" />
      {!runtime.available
        ? 'Local runtime missing'
        : runtime.loaded
          ? `${runtime.loaded.state === 'loading' ? 'Loading' : 'Running'} ${runtime.loaded.modelId}`
          : `llama.cpp${build ? ` b${build}` : ''}`}
      {runtime.loaded && (
        <button
          className="provider-link mlib-unload"
          onClick={() => void unload().catch((error: unknown) => notify(`Couldn't unload the model: ${errorText(error)}`, 'error'))}
        >
          Unload
        </button>
      )}
    </span>
  )
}
