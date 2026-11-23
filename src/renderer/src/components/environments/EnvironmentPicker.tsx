import { useRef, useState, type JSX } from 'react'
import { ChevronDown, Cloud, Laptop, Plus, Server, Settings2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { environmentsOf, environmentSummary, LOCAL_ENVIRONMENT, type CloudEnvironment } from '@shared/environments'
import { codeProject, useApp } from '../../state/store'
import { MenuItem, MenuSearch, MenuSeparator, Popover, useDisclosure } from '../ui'
import { EnvironmentDialog } from './EnvironmentDialog'
import { ProviderMark } from './Providers'
import './environments.css'

/**
 * An environment's mark: its provider's logo (exe.dev's too), or a server for
 * a machine over SSH. `tile` draws it on a tile of that size, as lists do.
 */
export function EnvironmentIcon({ env, size = 15, tile }: { env: (Pick<CloudEnvironment, 'kind'> & Partial<Pick<CloudEnvironment, 'provider'>>) | null; size?: number; tile?: number }): JSX.Element {
  const provider = env?.provider?.id ?? (env?.kind === 'exe' ? 'exe' : null)
  if (provider) return <ProviderMark id={provider} size={tile ?? size + 3} />
  const icon = !env ? <Laptop size={size} strokeWidth={1.8} /> : env.kind === 'exe' ? <Cloud size={size} strokeWidth={1.8} /> : <Server size={size} strokeWidth={1.8} />
  return tile ? (
    <span className="env-tile" style={{ width: tile, height: tile }}>
      {icon}
    </span>
  ) : (
    icon
  )
}

/** The environments set up, and which one a new session runs in (this computer when it's gone or none is picked). */
export function useEnvironments(): { list: CloudEnvironment[]; current: CloudEnvironment | null; pick: (id: string) => void } {
  const { saved, chosen, patchSettings } = useApp(useShallow((s) => ({ saved: s.settings?.environments, chosen: s.settings?.environment, patchSettings: s.patchSettings })))
  const list = environmentsOf(saved)
  const current = chosen && chosen !== LOCAL_ENVIRONMENT ? (list.find((e) => e.id === chosen) ?? null) : null
  return { list, current, pick: (id) => void patchSettings({ environment: id }) }
}

/**
 * Where the next session runs, under the message box on a project's start
 * page, beside the project: this computer, or one of the cloud environments
 * set up in Settings → Environments. Only there when one is: with none, a
 * session runs here as it always has.
 */
export function EnvironmentPicker(): JSX.Element | null {
  const { list, current, pick } = useEnvironments()
  const setSettingsPage = useApp((s) => s.setSettingsPage)
  // A project with its folder here: one on another machine already runs there, and a chat with none has nothing to copy.
  const local = useApp((s) => {
    const folder = codeProject(s)?.folder
    return Boolean(folder && !folder.startsWith('ssh://'))
  })
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  if (list.length === 0 || !local) return null

  const q = query.trim().toLowerCase()
  const match = (text: string): boolean => !q || text.toLowerCase().includes(q)
  const shown = list.filter((env) => match(env.name) || match(environmentSummary(env)))
  const choose = (id: string): void => {
    pick(id)
    menu.close()
  }

  return (
    <>
      <button
        ref={anchor}
        className="composer-pill composer-pill--env"
        data-open={menu.open || undefined}
        data-cloud={current ? true : undefined}
        onClick={() => {
          setQuery('')
          menu.toggle()
        }}
        title={current ? `Runs on ${current.name}: ${environmentSummary(current)}` : 'Runs on this computer'}
      >
        <EnvironmentIcon env={current} size={14} />
        <span className="composer-pill__label">{current ? current.name : 'This computer'}</span>
        <ChevronDown size={13} strokeWidth={2} className="composer-pill__chevron" />
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="top-start" width={320} className="env-menu">
        <MenuSearch value={query} onChange={setQuery} placeholder="Search environments" />
        {match('this computer') || match('local') ? (
          <>
            <div className="menu__label">Local</div>
            <MenuItem icon={<Laptop size={15} strokeWidth={1.8} />} title="This computer" checked={!current} onClick={() => choose(LOCAL_ENVIRONMENT)} />
          </>
        ) : null}
        {shown.length > 0 && (
          <>
            <MenuSeparator />
            <div className="menu__label">Cloud</div>
            {shown.map((env) => (
              <MenuItem key={env.id} icon={<EnvironmentIcon env={env} />} title={env.name} description={environmentSummary(env)} checked={current?.id === env.id} onClick={() => choose(env.id)} />
            ))}
          </>
        )}
        {q && shown.length === 0 && !match('this computer') && <div className="menu__empty">No environments match</div>}
        <MenuSeparator />
        <MenuItem
          icon={<Plus size={15} strokeWidth={1.8} />}
          title="New environment"
          onClick={() => {
            menu.close()
            setAdding(true)
          }}
        />
        <MenuItem
          icon={<Settings2 size={15} strokeWidth={1.8} />}
          title="Manage environments"
          onClick={() => {
            menu.close()
            setSettingsPage('environments')
          }}
        />
      </Popover>
      {adding && <EnvironmentDialog onClose={() => setAdding(false)} />}
    </>
  )
}
