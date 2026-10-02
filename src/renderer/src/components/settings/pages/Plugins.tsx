import { PluginCatalog } from '../../plugins/PluginCatalog'

/**
 * Same list as the main Plugins page (reached from the sidebar) — see
 * `PluginCatalog` for why this is one shared component rather than two.
 */
export function PluginsSettingsPage(): JSX.Element {
  return <PluginCatalog />
}
