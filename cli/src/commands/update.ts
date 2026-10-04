import { detectInstall, fetchDistTags, manualUpdate, newerVersion, readUpdateState, runUpdate, saveUpdateState, updated } from '../core/update'
import { CLI_BETA, CLI_PACKAGE, CLI_VERSION } from '../core/version'

/**
 * `eaon update`: asks npm for the newest version and installs it over this
 * copy, the way the app's update popup does. `--check` only looks.
 */
export async function runUpdateCommand(args: string[]): Promise<number> {
  const checkOnly = args.includes('--check')
  let tags: Record<string, string>
  try {
    tags = await fetchDistTags()
  } catch (error) {
    console.error(`Couldn’t ask npm about ${CLI_PACKAGE}: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  saveUpdateState({ ...readUpdateState(), checkedAt: Date.now(), tags })
  const latest = newerVersion(CLI_VERSION, tags)
  if (!latest) {
    console.log(`eaon ${CLI_VERSION} is the newest${CLI_BETA ? ' beta' : ''}.`)
    return 0
  }
  const install = detectInstall()
  console.log(`eaon ${latest} is out (you have ${CLI_VERSION}).`)
  if (checkOnly) {
    console.log(`Install it with: eaon update   (or ${manualUpdate(install, latest)})`)
    return 0
  }
  if (install.kind === 'source' || install.kind === 'npx') {
    console.log(`${install.kind === 'npx' ? 'This copy runs through npx' : 'This copy runs from a source checkout'}. Update it with: ${manualUpdate(install, latest)}`)
    return 0
  }
  console.log(`Running: ${manualUpdate(install, latest)}`)
  const result = await runUpdate(latest, (line) => console.log(`  ${line}`), install)
  if (!result.ok) {
    console.error(result.hint ?? 'The update didn’t finish.')
    if (result.command) console.error(`  ${result.command}`)
    return 1
  }
  updated()
  console.log(`Updated to ${result.installed ?? latest}. Open eaon again to use it.`)
  return 0
}
